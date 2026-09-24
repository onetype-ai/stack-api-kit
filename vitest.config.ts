import { defineConfig } from "vitest/config";

import { bothDialects, pgliteOnly } from "./tools/matrix.mjs";

// Every suite runs on SQLite; a suite that reaches a store runs on Postgres (PGlite) as well, named in tools/matrix.mjs.
export default defineConfig({
    test: {
        environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
        projects: [
            {
                extends: true,
                test: { name: "sqlite", include: ["src/**/tests/**/*.test.ts?(x)"], exclude: pgliteOnly, env: { KIT_DIALECT: "sqlite" } },
            },
            {
                extends: true,
                // one PGlite a worker, through the setup file projects use: isolation off keeps it across the worker's files
                test: { name: "postgres", include: [...bothDialects, ...pgliteOnly], env: { KIT_DIALECT: "postgres" }, isolate: false, setupFiles: ["src/testing-postgres.ts", "src/testing/tests/extensions.setup.ts"] },
            },
        ],
    },
});
