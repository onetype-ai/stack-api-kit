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

    // `Project.checks` reads the contract to list the keys a plugin may
    // declare, so the file itself ships, not only its types.
    async onSuccess()
    {
        const { copyFile } = await import("node:fs/promises");

        await copyFile("src/plugins/kernel/internal/contract.ts", "dist/contract.ts");
    },
});
