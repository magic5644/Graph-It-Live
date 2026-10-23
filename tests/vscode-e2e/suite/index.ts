import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

/**
 * Suites to run: `E2E_SUITE_GLOB` (relative to the compiled test root), or every suite.
 * Backslashes become `/` because glob reads `\` as an escape, even on Windows.
 */
export function suiteGlob(env: NodeJS.ProcessEnv = process.env): string {
  return env.E2E_SUITE_GLOB?.trim().replaceAll('\\', '/') || '**/**.test.js';
}

export async function run(): Promise<void> {
  const reporter = process.env.E2E_MOCHA_REPORTER || 'spec';
  const reporterOptions = process.env.E2E_MOCHA_REPORT_FILE
    ? {
      output: path.resolve(process.env.E2E_MOCHA_REPORT_FILE),
    }
    : undefined;

  // Create the mocha test
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 20000, // VSCode operations can be slow
    reporter,
    reporterOptions,
  });

  const testsRoot = path.resolve(__dirname, '..');

  return new Promise((resolve, reject) => {
    glob(suiteGlob(), { cwd: testsRoot })
      .then((files) => {
        // A mistyped glob would run 0 tests and pass.
        if (files.length === 0) throw new Error(`No E2E suite matches "${suiteGlob()}"`);
        // Add files to the test suite
        files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

        try {
          // Run the mocha test
          mocha.run((failures) => {
            if (failures > 0) {
              reject(new Error(`${failures} tests failed.`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          console.error(err);
          reject(err);
        }
      })
      .catch((err) => {
        reject(err);
      });
  });
}
