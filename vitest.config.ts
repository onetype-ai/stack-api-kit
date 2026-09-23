import { defineConfig } from "vitest/config";

import { bothDialects } from "./tools/matrix.mjs";

// Every suite runs on SQLite; a suite that reaches a store runs on Postgres (PGlite) as well, named in tools/matrix.mjs.
export default defineConfig({
    test: {
        environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
        projects: [
            {
                extends: true,
                test: { name: "sqlite", include: ["src/**/tests/**/*.test.ts?(x)"], env: { KIT_DIALECT: "sqlite" } },
            },
            {
                extends: true,
                test: { name: "postgres", include: bothDialects, env: { KIT_DIALECT: "postgres" } },
            },
        ],
    },
});
