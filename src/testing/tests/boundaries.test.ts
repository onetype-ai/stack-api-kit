import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { findCopiedVocabulary, findImportViolations, findSharedNames, findSplitVocabulary } from "../boundaries";

let root = "";

afterEach(() =>
{
    if (root !== "")
    {
        rmSync(root, { recursive: true, force: true });
        root = "";
    }
});

/** Writes a plugin tree on disk, because that is what the check reads. */
function tree(plugins: Readonly<Record<string, Readonly<Record<string, string>>>>): string
{
    root = mkdtempSync(join(tmpdir(), "boundaries-"));

    for (const [name, files] of Object.entries(plugins))
    {
        for (const [path, source] of Object.entries(files))
        {
            const full = join(root, name, path);

            mkdirSync(join(full, ".."), { recursive: true });
            writeFileSync(full, source);
        }
    }

    return root;
}

const contractFor = (name: string, needs: readonly string[] = []): string =>
    `export default definePlugin("${name}", { dependsOn: [${needs.map((need) => `"${need}"`).join(", ")}] });`;

describe("a plugin reaching another", () =>
{
    test("passes when it is declared and goes through the public index", () =>
    {
        const problems = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import { useAuth } from "@plugins/auth";',
                },
            }),
        );

        expect(problems).toEqual([]);
    });

    test("refuses an import nothing declared", () =>
    {
        const problems = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo"),
                    "services/items.ts": 'import { useAuth } from "@plugins/auth";',
                },
            }),
        );

        expect(problems.map((violation) => violation.rule)).toContain("undeclared");
        expect(problems[0]?.message).toMatch(/without declaring "auth"/);
    });

    test("refuses a reach past the public index", () =>
    {
        const problems = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import { Session } from "@plugins/auth/types/Session";',
                },
            }),
        );

        expect(problems.map((violation) => violation.rule)).toContain("deep");
    });

    test("refuses a relative path that climbs into another plugin", () =>
    {
        const problems = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth"), "types/Session.ts": "export type Session = { id: string };" },
                demo: {
                    "plugin.ts": contractFor("demo", ["auth"]),
                    "services/items.ts": 'import type { Session } from "../../auth/types/Session";',
                },
            }),
        );

        expect(problems.map((violation) => violation.rule)).toContain("deep");
        expect(problems.some((violation) => violation.message.includes("../../auth/types/Session"))).toBe(true);
    });

    test("ignores a relative import inside one plugin", () =>
    {
        const problems = findImportViolations(
            tree({
                demo: {
                    "plugin.ts": contractFor("demo"),
                    "services/items.ts": 'import { DemoItem } from "../types/DemoItem";',
                    "types/DemoItem.ts": "export type DemoItem = { id: string };",
                },
            }),
        );

        expect(problems).toEqual([]);
    });
});

describe("cycles", () =>
{
    test("names a loop between two plugins", () =>
    {
        const problems = findImportViolations(
            tree({
                a: { "plugin.ts": contractFor("a", ["b"]), "use.ts": 'import { b } from "@plugins/b";' },
                b: { "plugin.ts": contractFor("b", ["a"]), "use.ts": 'import { a } from "@plugins/a";' },
            }),
        );

        const cycle = problems.find((violation) => violation.rule === "cycle");

        expect(cycle?.message).toMatch(/a -> b -> a|b -> a -> b/);
    });

    test("a one-way dependency is not a cycle", () =>
    {
        const problems = findImportViolations(
            tree({
                auth: { "plugin.ts": contractFor("auth") },
                demo: { "plugin.ts": contractFor("demo", ["auth"]), "use.ts": 'import { auth } from "@plugins/auth";' },
            }),
        );

        expect(problems.filter((violation) => violation.rule === "cycle")).toEqual([]);
    });

    // A listener boots what it hears, and the emitter may depend on it: that
    // is a loop on paper and never at runtime, since nothing a deployment
    // loads imports the other way.
    test("and neither is a test booting the plugin whose events it hears", () =>
    {
        const problems = findImportViolations(
            tree({
                activity: {
                    "plugin.ts": `${contractFor("activity")}\nlistens: { "admin.viewed": {} }`,
                    "tests/setup.ts": 'import admin from "@plugins/admin/plugin";',
                },
                admin: {
                    "plugin.ts": `${contractFor("admin", ["activity"])}\nemits: { "admin.viewed": {} }`,
                    "use.ts": 'import { Activity } from "@plugins/activity";',
                },
            }),
        );

        expect(problems.filter((violation) => violation.rule === "cycle")).toEqual([]);
    });

    test("but a loop through production code is still one, whatever the tests do", () =>
    {
        const problems = findImportViolations(
            tree({
                a: {
                    "plugin.ts": contractFor("a", ["b"]),
                    "use.ts": 'import { b } from "@plugins/b";',
                    "tests/setup.ts": 'import b from "@plugins/b/plugin";',
                },
                b: { "plugin.ts": contractFor("b", ["a"]), "use.ts": 'import { a } from "@plugins/a";' },
            }),
        );

        expect(problems.filter((violation) => violation.rule === "cycle").length).toBeGreaterThan(0);
    });
});

describe("what a test may reach", () =>
{
    function built(declared: string): string
    {
        const at = mkdtempSync(join(tmpdir(), "boundaries-tests-"));

        mkdirSync(join(at, "orders", "tests"), { recursive: true });
        mkdirSync(join(at, "catalog"), { recursive: true });

        writeFileSync(join(at, "orders", "plugin.ts"), `export default definePlugin("orders", { dependsOn: [${declared}] });\n`);
        writeFileSync(join(at, "catalog", "plugin.ts"), 'export default definePlugin("catalog", {});\n');

        return at;
    }

    test("a test may boot a dependency it declared", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at)).toEqual([]);

        rmSync(at, { recursive: true, force: true });
    });

    test("a test may not boot a plugin it never declared", () =>
    {
        const at = built("");

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule).sort()).toEqual(["deep", "undeclared"]);

        rmSync(at, { recursive: true, force: true });
    });

    test("a test may not reach past a dependency's contract", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "tests", "api.test.ts"), 'import { rows } from "@plugins/catalog/tables/rows";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule)).toEqual(["deep"]);

        rmSync(at, { recursive: true, force: true });
    });

    test("code outside tests may not name a contract at all", () =>
    {
        const at = built('"catalog"');

        writeFileSync(join(at, "orders", "services.ts"), 'import catalog from "@plugins/catalog/plugin";\n');

        expect(findImportViolations(at).map((wrong) => wrong.rule)).toEqual(["deep"]);

        rmSync(at, { recursive: true, force: true });
    });
});

describe("an import that leaves the process", () =>
{
    test("is reported, because no key in the contract declares it", () =>
    {
        const problems = findImportViolations(
            tree({
                cli: {
                    "plugin.ts": contractFor("cli"),
                    "services/Ask.ts": 'import { spawn } from "node:child_process";',
                },
            }),
        );

        expect(problems).toHaveLength(1);
        expect(problems[0]?.rule).toBe("escape");
        expect(problems[0]?.message).toContain("node:child_process");
        expect(problems[0]?.message).toContain("services/Ask.ts");
    });

    test("names a thread, a vm and a fork the same way, not only a spawn", () =>
    {
        const problems = findImportViolations(
            tree({
                many: {
                    "plugin.ts": contractFor("many"),
                    "a.ts": 'import { Worker } from "node:worker_threads";',
                    "b.ts": 'import { runInNewContext } from "node:vm";',
                    "c.ts": 'import cluster from "node:cluster";',
                },
            }),
        );

        expect(problems.map((one) => one.rule)).toEqual(["escape", "escape", "escape"]);
    });

    test("leaves every other builtin alone: reading a file is not leaving", () =>
    {
        const problems = findImportViolations(
            tree({
                plain: {
                    "plugin.ts": contractFor("plain"),
                    "a.ts": 'import { readFile } from "node:fs/promises";\nimport { createHash } from "node:crypto";\nimport { join } from "node:path";',
                },
            }),
        );

        expect(problems).toEqual([]);
    });

    test("a test that spawns is reported too: the file it sits in changes nothing it inherits", () =>
    {
        const problems = findImportViolations(
            tree({
                cli: {
                    "plugin.ts": contractFor("cli"),
                    "tests/runs.test.ts": 'import { execFile } from "node:child_process";',
                },
            }),
        );

        expect(problems).toHaveLength(1);
        expect(problems[0]?.rule).toBe("escape");
    });
});

describe("a util two plugins each wrote", () =>
{
    const util = (name: string, signature: string, body: string): string =>
        `class ${name}\n{\n    ${signature}\n    {\n        ${body}\n    }\n}\n\nexport const ${name} = new ${name}();\n`;

    test("is named when the signature is written in two plugins, however differently", () =>
    {
        const shared = findSharedNames(
            tree({
                one: { "plugin.ts": contractFor("one"), "utils/Text.ts": util("T", "searchable(raw: string): string", "return raw.toLowerCase();") },
                two: { "plugin.ts": contractFor("two"), "utils/Words.ts": util("W", "searchable(raw: string): string", "return raw.normalize(\"NFD\");") },
            }),
        );

        expect(shared).toHaveLength(1);
        expect(shared[0]?.signature).toBe("searchable(raw: string): string");
        expect(shared[0]?.plugins).toEqual(["one", "two"]);
    });

    test("a signature one plugin alone writes is nobody's business", () =>
    {
        const shared = findSharedNames(
            tree({
                one: { "plugin.ts": contractFor("one"), "utils/Text.ts": util("T", "searchable(raw: string): string", "return raw;") },
                two: { "plugin.ts": contractFor("two"), "utils/Sums.ts": util("S", "total(of: readonly number[]): number", "return 0;") },
            }),
        );

        expect(shared).toEqual([]);
    });

    test("two answering different questions are held apart by their own types, with nothing to declare", () =>
    {
        const shared = findSharedNames(
            tree({
                one: { "plugin.ts": contractFor("one"), "utils/A.ts": util("A", "rank(role: string): number", "return 0;") },
                two: { "plugin.ts": contractFor("two"), "utils/B.ts": util("B", "rank(score: readonly number[]): number", "return 0;") },
            }),
        );

        expect(shared).toEqual([]);
    });

    test("only utils are read: a service is meant to know its own domain", () =>
    {
        const shared = findSharedNames(
            tree({
                one: { "plugin.ts": contractFor("one"), "services/Items.ts": util("I", "listed(of: string): string", "return of;") },
                two: { "plugin.ts": contractFor("two"), "services/Rows.ts": util("R", "listed(of: string): string", "return of;") },
            }),
        );

        expect(shared).toEqual([]);
    });

    test("one plugin writing the same signature twice is its own affair", () =>
    {
        const shared = findSharedNames(
            tree({
                one: {
                    "plugin.ts": contractFor("one"),
                    "utils/A.ts": util("A", "of(raw: string): string", "return raw;"),
                    "utils/B.ts": util("B", "of(raw: string): string", "return raw;"),
                },
            }),
        );

        expect(shared).toEqual([]);
    });
});

describe("one word naming two closed sets", () =>
{
    const enumFor = (name: string, values: readonly string[]): string =>
        `import { z } from "zod";\n\nexport const ${name} = z.enum([${values.map((one) => `"${one}"`).join(", ")}]);\n`;

    test("is named when two plugins nearly, but not quite, agree on it", () =>
    {
        const split = findSplitVocabulary(
            tree({
                account: { "plugin.ts": contractFor("account"), "schemas/Role.ts": enumFor("Role", ["owner", "admin", "member", "staff"]) },
                workspace: { "plugin.ts": contractFor("workspace", ["account"]), "schemas/Role.ts": enumFor("Role", ["owner", "admin", "member"]) },
            }),
        );

        expect(split).toHaveLength(1);
        expect(split[0]?.name).toBe("Role");
        expect(split[0]?.shared).toEqual(["admin", "member", "owner"]);
        expect(split[0]?.apart).toEqual(["staff"]);
    });

    test("and left alone when neither reaches the other, since a word may mean two things in two domains", () =>
    {
        const split = findSplitVocabulary(
            tree({
                account: { "plugin.ts": contractFor("account"), "schemas/Role.ts": enumFor("Role", ["owner", "admin", "member", "staff"]) },
                workspace: { "plugin.ts": contractFor("workspace"), "schemas/Role.ts": enumFor("Role", ["owner", "admin", "member"]) },
            }),
        );

        expect(split).toEqual([]);
    });

    test("and left alone when the two share nothing, since a word may mean two things", () =>
    {
        const split = findSplitVocabulary(
            tree({
                account: { "plugin.ts": contractFor("account"), "schemas/Role.ts": enumFor("Role", ["owner", "admin"]) },
                conversation: { "plugin.ts": contractFor("conversation"), "schemas/Turn.ts": enumFor("Role", ["visitor", "bot"]) },
            }),
        );

        expect(split).toEqual([]);
    });

    test("and left alone when the two agree exactly, which is one idea written twice and nothing worse", () =>
    {
        const split = findSplitVocabulary(
            tree({
                account: { "plugin.ts": contractFor("account"), "schemas/Role.ts": enumFor("Role", ["owner", "admin"]) },
                workspace: { "plugin.ts": contractFor("workspace"), "schemas/Role.ts": enumFor("Role", ["admin", "owner"]) },
            }),
        );

        expect(split).toEqual([]);
    });

    test("and says nothing about one plugin holding two of its own", () =>
    {
        const split = findSplitVocabulary(
            tree({
                account: {
                    "plugin.ts": contractFor("account"),
                    "schemas/Role.ts": enumFor("Role", ["owner", "admin", "staff"]),
                    "schemas/Seat.ts": enumFor("Role", ["owner", "admin"]),
                },
            }),
        );

        expect(split).toEqual([]);
    });
});

describe("a set one plugin wrote out where another names it", () =>
{
    const enumFor = (name: string, values: readonly string[]): string =>
        `import { z } from "zod";\n\nexport const ${name} = z.enum([${values.map((one) => `"${one}"`).join(", ")}]);\n`;

    test("is named, because a copy with no name is one nothing compares", () =>
    {
        const copied = findCopiedVocabulary(
            tree({
                workspace: { "plugin.ts": contractFor("workspace"), "schemas/Role.ts": enumFor("Role", ["owner", "admin", "member"]) },
                mailer: {
                    "plugin.ts": contractFor("mailer"),
                    "schemas/Data.ts": 'import { z } from "zod";\n\nexport const Data = z.object({\n    role: z.enum(["owner", "admin", "member"]),\n});\n',
                },
            }),
        );

        expect(copied).toHaveLength(1);
        expect(copied[0]?.name).toBe("Role");
        expect(copied[0]?.owner).toBe("workspace");
        expect(copied[0]?.copier).toBe("mailer");
    });

    test("and left alone when the set is one nobody else named", () =>
    {
        const copied = findCopiedVocabulary(
            tree({
                billing: {
                    "plugin.ts": contractFor("billing"),
                    "schemas/Config.ts": 'import { z } from "zod";\n\nexport const Config = z.object({\n    provider: z.enum(["stored", "stripe"]),\n});\n',
                },
            }),
        );

        expect(copied).toEqual([]);
    });

    test("and left alone when a plugin writes out a set it named itself", () =>
    {
        const copied = findCopiedVocabulary(
            tree({
                workspace: {
                    "plugin.ts": contractFor("workspace"),
                    "schemas/Role.ts": enumFor("Role", ["owner", "admin"]),
                    "schemas/Seat.ts": 'import { z } from "zod";\n\nexport const Seat = z.object({\n    role: z.enum(["owner", "admin"]),\n});\n',
                },
            }),
        );

        expect(copied).toEqual([]);
    });
});
