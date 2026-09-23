import { beforeAll } from "vitest";

import { sharedPglite } from "../pglite";

// started once before a worker's first suite, so no test pays the seconds PGlite takes
beforeAll(async () =>
{
    await sharedPglite();
}, 60_000);
