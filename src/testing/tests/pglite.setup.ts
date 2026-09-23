import { beforeAll } from "vitest";

import { forgetStored } from "../../plugins/kernel/internal/stored";
import { sharedPglite } from "../pglite";
import { forgetTestKernelState } from "../startTestKernel";

// the postgres project keeps a worker's modules across its files: what one file configured must not reach the next
forgetTestKernelState();
forgetStored();

// started once before a worker's first suite, so no test pays the seconds PGlite takes
beforeAll(async () =>
{
    await sharedPglite();
}, 60_000);
