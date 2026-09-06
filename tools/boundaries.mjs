#!/usr/bin/env node
//
// The rules the compiler cannot enforce. Run from the repository root.
//
//   1. A plugin imports another only through its api.ts.
//   2. Plugin names appear outside their own folder in exactly one file.
//   3. Every plugin has the structure #docs/procedures/plugin-structure.md
//      describes.
//   5. No plugin reaches a driver the kit is meant to hold: a plugin that
//      opened its own connection or called fetch would be a second boundary.
//   6. internal/ never imports an entry, and exports carries no wildcard.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = "src/plugins";
const entry = "src/index.ts";

// The package's entries. Each names plugins because that is what an entry is
// for: assembling them is the one job nothing else in here may do.
const entries = ["src/index.ts", "src/testing.ts"];
let failed = 0;

function fault(message)
{
    console.log(`BOUNDARY  ${message}`);
    failed = 1;
}

// walk lists every source file under a directory.
function walk(path)
{
    if (!existsSync(path))
    {
        return [];
    }

    const found = [];

    for (const name of readdirSync(path))
    {
        const full = join(path, name);

        if (statSync(full).isDirectory())
        {
            found.push(...walk(full));
            continue;
        }

        if (/\.tsx?$/.test(name))
        {
            found.push(full);
        }
    }

    return found;
}

// imports lists what one file imports, and whether the import survives to
// runtime.
//
// A type import is erased: `import type { ComponentType } from "react"` adds
// no dependency, reaches no DOM, and creates no cycle. Treating it as a value
// import is a check stronger than its rule, which refuses correct code and
// teaches everyone to work around the tool.
function imports(source)
{
    const found = [];
    const patterns = [
        /(?:^|\s)(import|export)(\s+type)?\s[^;]*?from\s+["']([^"']+)["']/g,
        /\b(import)()\s*\(\s*["']([^"']+)["']\s*\)/g,
        /(?:^|\s)(import)()\s+["']([^"']+)["']/g,
    ];

    for (const pattern of patterns)
    {
        for (const match of source.matchAll(pattern))
        {
            const whole = match[0];
            const path = match[3];

            // `import type {...}` and `import { type X }` are both erased.
            const erased = match[2] !== undefined && match[2].trim() === "type"
                ? true
                : /\{[^}]*\}/.test(whole) && /\{\s*type\s/.test(whole) && !/\{[^}]*,\s*[A-Za-z_$]/.test(whole.replace(/type\s+\w+/g, ""));

            found.push({ path, erased });
        }
    }

    return found;
}

/** Just the specifiers, for a rule that does not care how they are imported. */
function paths(source)
{
    return imports(source).map((each) => each.path);
}

const plugins = existsSync(root)
    ? readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory())
    : [];

// 2. Plugin names appear outside their own folder in exactly one file.
//
// A sibling reaching another is rule 1's to report, with the reason it broke,
// so this one covers everything else: the entries, and anything added later.
for (const name of plugins)
{
    for (const file of walk("src"))
    {
        if (file.startsWith(root) || entries.includes(file) || file.startsWith("src/testing/"))
        {
            continue;
        }

        if (paths(readFileSync(file, "utf8")).some((specifier) => specifier.includes(`plugins/${name}`)))
        {
            fault(`${relative(".", file)} names ${name}: only an entry may`);
        }
    }
}

for (const name of plugins)
{
    const path = join(root, name);

    // 3. Structure.
    for (const required of ["usage.md", "api.ts"])
    {
        if (!existsSync(join(path, required)))
        {
            fault(`${name} has no ${required}`);
        }
    }

    if (!existsSync(join(path, "tests")))
    {
        fault(`${name} has no tests/`);
    }

    // Only the named files may sit at a plugin's top level.
    for (const file of readdirSync(path))
    {
        if (statSync(join(path, file)).isDirectory() || !/\.tsx?$/.test(file))
        {
            continue;
        }

        if (!["api.ts", "events.ts", "hooks.ts"].includes(file))
        {
            fault(`${name}: ${file} is not one of the named top-level files`);
        }
    }

    for (const file of walk(path))
    {
        const where = relative(".", file);
        const source = readFileSync(file, "utf8");
        const inside = file.startsWith(join(path, "internal"));
        const tested = file.startsWith(join(path, "tests"));

        for (const { path: specifier, erased } of imports(source))
        {
            // 1. Another plugin, and only through api.ts.
            //
            // Resolve the specifier against the file that wrote it, so what is
            // compared is the path on disk rather than the shape someone
            // typed. "../../kernel" means our runtime from a plugin's
            // internal/ and the sibling plugin from the plugin folder, and
            // only resolving tells them apart.
            //
            // Matching the text alone let a relative path climb out of a
            // folder and reach a private file while the rule read as enforced.
            const landed = specifier.startsWith(".") ? relative(".", join(dirname(file), specifier)) : specifier;

            for (const other of plugins)
            {
                const folder = join(root, other);
                const named = landed === folder || landed.startsWith(`${folder}/`);

                if (other === name || !named)
                {
                    continue;
                }

                if (specifier.includes("/internal"))
                {
                    fault(`${where} imports ${other}'s internal`);
                }
            }

            // 4. Only the plugin that owns a driver may import it. Every
            //    other plugin goes through the kernel's context.
            const drivers = {
                "better-sqlite3": "database",
                "drizzle-orm": "database",
                hono: "http",
            };

            for (const [driver, owner] of Object.entries(drivers))
            {
                if (!erased && (specifier === driver || specifier.startsWith(`${driver}/`)) && name !== owner && !tested)
                {
                    fault(`${where} imports ${driver}, which only ${owner} may`);
                }
            }

            // 5. internal/ must not climb to its own plugin's entry for a
            //    value.
            //
            // A type the entry owns has to be usable inside, or every shared
            // shape would be defined twice. A sibling's entry is rule 2's to
            // judge, and reporting it here would name the wrong rule.
            const own = landed.startsWith(`${path}/`) || landed === path;

            if (inside && own && !erased && /(^|\/)api$/.test(specifier.replace(/\.tsx?$/, "")))
            {
                fault(`${where} imports an entry from internal/`);
            }
        }

        // Everything outbound goes through ctx.fetch, which checks the host
        // against what the plugin declared. A bare fetch skips that entirely.
        if (!tested && name !== "outbound" && /(^|[^.\w])fetch\s*\(/.test(source))
        {
            fault(`${where} calls fetch directly: go through ctx.fetch`);
        }
    }
}

// 5. exports lists entries only.
if (existsSync("package.json"))
{
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const exported = manifest.exports ?? {};

    if (Object.keys(exported).some((key) => key.includes("*")))
    {
        fault("exports carries a wildcard, which makes every internal file public");
    }

    for (const target of Object.values(exported))
    {
        const file = typeof target === "string" ? target : target?.default;

        if (typeof file === "string" && file.includes("/internal/"))
        {
            fault("exports points into internal/");
        }
    }

    for (const driver of ["better-sqlite3", "drizzle-orm", "hono"])
    {
        if (manifest.dependencies?.[driver])
        {
            fault(`${driver} is a dependency, not a peer`);
        }
    }
}

// 2. Every plugin is reachable from the entry: one nothing exports is one no
//    project can use, and nothing else says so.
if (existsSync(entry))
{
    const source = readFileSync(entry, "utf8");

    for (const name of plugins)
    {
        if (!paths(source).some((specifier) => specifier.includes(`plugins/${name}`)))
        {
            fault(`${name} is not exported from ${entry}: nothing can reach it`);
        }
    }
}

if (failed === 0)
{
    console.log("boundaries hold");
}

process.exit(failed);
