import Tinypool from "tinypool";
import supportsColor from "supports-color";
import { MessageChannel } from "worker_threads";
import { shouldInstrument } from "@jest/transform";
import { fileURLToPath, pathToFileURL } from "url";

/** @typedef {import("@jest/test-result").Test} Test */

export default class LightRunner {
  // TODO: Use real private fields when we drop support for Node.js v12
  _config;
  _pool;
  _testContext;

  constructor(config, testContext) {
    this._config = config;
    this._testContext = testContext;

    // Jest's logic to decide when to spawn workers and when to run in the
    // main thread is quite complex:
    //  https://github.com/facebook/jest/blob/5183c1/packages/jest-core/src/testSchedulerHelper.ts#L13
    // We will only run in the main thread when `maxWorkers` is 1.
    // It's always 1 when using the `--runInBand` option.
    // This is so that the tests shares the same global context as Jest only
    // when explicitly required, to prevent them from accidentally interferring
    // with the test runner. Jest's default runner does not have this problem
    // because it isolates every test in a vm.Context.
    const { maxWorkers } = config;
    const runInBand = maxWorkers === 1;

    this._pool = new (runInBand ? InBandTinypool : Tinypool)({
      filename: new URL("./worker-runner.js", import.meta.url).href,
      maxThreads: maxWorkers,
      env: {
        // Workers don't have a tty; we whant them to inherit
        // the color support level from the main thread.
        FORCE_COLOR: supportsColor.stdout.level,
        ...process.env,
      },
    });
  }

  /**
   * @param {Array<Test>} tests
   * @param {*} watcher
   * @param {*} onStart
   * @param {*} onResult
   * @param {*} onFailure
   */
   async runTests(tests, watcher, onStart, onResult, onFailure) {
    const {
      updateSnapshot,
      testNamePattern,
      collectCoverage,
      coverageProvider,
    } = this._config;

    // if (this._config.globalSetup) {
    //   // Superglobal setup
    //   const { default: setup } = await import(pathToFileURL(this._config.globalSetup));
    //   if (typeof setup === "function") await setup();
    // }
    const res = await Promise.all(
      tests.map(async (test, index) => {
        const mc = new MessageChannel();
        mc.port2.onmessage = () => onStart(test);
        mc.port2.unref();


        const res = await this._pool
        .run(
          {
            test,
            updateSnapshot,
            testNamePattern,
            port: mc.port1,
            collectV8Coverage: collectCoverage && coverageProvider === "v8",
          },
          { transferList: [mc.port1] }
        )
        .then(
          result =>
            void onResult(
              test,
              this.filterCoverage(result, test.context.config)
            ),
          error => void onFailure(test, error)
        );

        if (index === tests.length - 1 && this._config.globalTeardown) {
          // Superglobal teardown
          const { default: teardown } = await import(pathToFileURL(this._config.globalTeardown));
          if (typeof teardown === "function") await teardown();
        }

        return res
      })
    );
    return res;
  }

  filterCoverage(result, projectConfig) {
    if (!result.v8Coverage) {
      return result;
    }

    const coverageOptions = {
      changedFiles: this._testContext.changedFiles,
      collectCoverage: true,
      collectCoverageFrom: this._config.collectCoverageFrom,
      collectCoverageOnlyFrom: this._config.collectCoverageOnlyFrom,
      coverageProvider: this._config.coverageProvider,
      sourcesRelatedToTestsInChangedFiles:
        this._testContext.sourcesRelatedToTestsInChangedFiles,
    };

    return {
      ...result,
      v8Coverage: result.v8Coverage
        .filter(res => res.url.startsWith("file://"))
        .map(res => ({ ...res, url: fileURLToPath(res.url) }))
        .filter(
          ({ url }) =>
            // TODO: will this work on windows? It might be better if `shouldInstrument` deals with it anyways
            url.startsWith(projectConfig.rootDir) &&
            shouldInstrument(url, coverageOptions, projectConfig)
        )
        .map(result => ({ result })),
    };
  }
}

// Exposes an API similar to Tinypool, but it uses dynamic import()
// rather than worker_threads.
class InBandTinypool {
  _moduleP;
  _moduleDefault;

  _queue = [];
  _running = false;

  constructor({ filename }) {
    this._moduleP = import(filename);
  }

  run(data) {
    return new Promise((resolve, reject) => {
      this._queue.push({ data, resolve, reject });
      this._runQueue();
    });
  }

  async _runQueue() {
    if (this._running) return;
    this._running = true;

    try {
      if (!this._moduleDefault) {
        this._moduleDefault = (await this._moduleP).default;
      }

      while (this._queue.length > 0) {
        const { data, resolve, reject } = this._queue.shift();
        await this._moduleDefault(data).then(resolve, reject);
      }
    } finally {
      this._running = false;
    }
  }
}
