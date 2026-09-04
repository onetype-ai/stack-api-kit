import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/testing.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    target: "node22",

    // Peers stay peers: one copy of drizzle in a project, never two.
    external: ["better-sqlite3", "drizzle-orm", "hono", "zod"],
});
