import { defineConfig } from "vitest/config";

import { postgresServer } from "./tools/matrix.mjs";

// Against a real Postgres server: two connections contend only there. Run with KIT_PG_URL set, as
// `infra/remote-verify.sh --with-pg --lane kit <kit> "pnpm test:pg"` does.
export default defineConfig({
    test: {
        name: "postgres-server",
        include: postgresServer,
        env: { KIT_DIALECT: "postgres" },
        testTimeout: 60_000,
    },
});
