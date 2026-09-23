#!/usr/bin/env node
//
// What the plugins in a module declare. The kit does not know an
// application's plugins, so the module holding them is named on the command
// line.
//
//   node tools/declared.mjs ./src/kernel/plugins.js
//   node tools/declared.mjs ./src/kernel/plugins.js shop
//   node tools/declared.mjs ./src/kernel/plugins.js --json
//
// The module may export an array, or a `plugins` / `Plugins` binding holding
// one. A `discover()` on it is awaited, which is how a folder-scanning
// project hands its plugins over.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { declarationsOf } from "../dist/index.js";

const [, , from, ...rest] = process.argv;
const asJson = rest.includes("--json");
const named = rest.find((each) => !each.startsWith("--"));

if (from === undefined)
{
    console.error("Name the module holding the plugins: node tools/declared.mjs ./src/kernel/plugins.js [name] [--json]");
    process.exit(2);
}

// A default export, a named one, or a discover() that reads a folder: three
// shapes one project or another already uses.
async function pluginsFrom(module)
{
    const exported = module.default ?? module.plugins ?? module.Plugins ?? module;

    if (Array.isArray(exported))
    {
        return exported;
    }

    if (typeof exported?.discover === "function")
    {
        return await exported.discover();
    }

    if (Array.isArray(exported?.plugins))
    {
        return exported.plugins;
    }

    return [];
}

function lines(declared)
{
    const out = [];

    for (const plugin of declared)
    {
        const needs = plugin.dependsOn.length > 0 ? `  needs: ${plugin.dependsOn.join(", ")}` : "";

        out.push(`\n${plugin.name}  v${plugin.version}${needs}`);

        if (plugin.describe !== "")
        {
            out.push(`  ${plugin.describe}`);
        }

        for (const route of plugin.routes)
        {
            const open = route.public ? "public" : route.requires.join(", ") || "signed in";
            const limit = route.limit === undefined ? "" : `, ${route.limit.requests}/${route.limit.seconds}s`;

            out.push(`    route      ${route.method.padEnd(6)} ${route.path}  (${open}${limit})`);
        }

        for (const [label, entries] of [
            ["emits", plugin.emits],
            ["listens", plugin.listens],
            ["channel", plugin.channels],
            ["hook", plugin.hooks],
            ["joins", plugin.participates],
        ])
        {
            for (const entry of entries)
            {
                out.push(`    ${label.padEnd(10)} ${entry.name}`);
            }
        }

        for (const command of plugin.commands)
        {
            const needs = command.requires.length > 0 ? `  (${command.requires.join(", ")})` : "";

            out.push(`    command    ${command.name}${needs}`);
        }

        for (const registry of plugin.registries ?? [])
        {
            out.push(`    registry   ${registry.name}  (key ${registry.key})`);
        }

        for (const addition of plugin.adds ?? [])
        {
            out.push(`    adds       ${addition.registry}: ${addition.keys.filter(Boolean).join(", ")}`);
        }

        for (const pipeline of plugin.pipelines ?? [])
        {
            out.push(`    pipeline   ${pipeline.name}: ${pipeline.steps.map((step) => (step.owner === plugin.name ? step.id : `${step.id} (${step.owner})`)).join(" → ")}`);

            for (const problem of pipeline.problems)
            {
                out.push(`      refused  ${problem}`);
            }
        }

        if (plugin.tables.length > 0)
        {
            out.push(`    tables     ${plugin.tables.join(", ")}`);
        }

        if (plugin.scope !== undefined)
        {
            out.push(`    scope      by "${plugin.scope.claim}" over ${plugin.scope.tables.join(", ")}`);
        }

        if (plugin.allowedHosts === "anywhere" || plugin.allowedHosts.length > 0)
        {
            const hosts = plugin.allowedHosts === "anywhere" ? "anywhere" : plugin.allowedHosts.join(", ");

            out.push(`    calls      ${hosts}`);
        }
    }

    return out.join("\n");
}

const module = await import(pathToFileURL(resolve(from)).href);
const plugins = await pluginsFrom(module);

if (plugins.length === 0)
{
    console.error(`${from} exports no plugins: export an array, a "plugins" binding, or a discover().`);
    process.exit(1);
}

const declared = declarationsOf(plugins, named);

if (named !== undefined && declared.length === 0)
{
    console.error(`No plugin is named "${named}". Found: ${plugins.map((each) => each.name).join(", ")}`);
    process.exit(1);
}

console.log(asJson ? JSON.stringify(declared, null, 2) : lines(declared).trimStart());
