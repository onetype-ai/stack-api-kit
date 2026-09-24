// A vitest setup file for a project's Postgres test run: `setupFiles: ["@onetype/stack-api-kit/testing/postgres"]` with
// `isolate: false`, so a worker keeps one PGlite and its migrated schemas across its files. What one file configured
// is forgotten before the next, and PGlite is started before the worker's first suite, so no test pays for it.
import { forgetStored } from "./plugins/kernel/api";
import { sharedPglite } from "./testing/pglite";
import { forgetTestKernelState } from "./testing/startTestKernel";

forgetTestKernelState();
forgetStored();

await sharedPglite();
