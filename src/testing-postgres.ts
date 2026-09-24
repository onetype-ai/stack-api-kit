// A vitest setup file for a project's Postgres test run: `setupFiles: ["@onetype/stack-api-kit/testing/postgres"]` with
// `isolate: false`, so a worker keeps one PGlite and its migrated schemas across its files, and what one file
// configured is forgotten before the next. Extensions are named in the project's own setup file, after this one.
import { forgetStored } from "./plugins/kernel/api";
import { forgetTestKernelState } from "./testing/startTestKernel";

forgetTestKernelState();
forgetStored();
