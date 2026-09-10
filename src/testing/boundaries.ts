import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export type ImportEdge = {
    from: string;
    to: string;
    specifier: string;
};

export type ImportViolation = {
    rule: "undeclared" | "deep" | "cycle" | "contract" | "escape" | "twice";
    message: string;
};

type ImportsByPlugin = {
    name: string;
    declared: Set<string>;

    /** Plugins whose events or hooks this one answers. */
    answers: Set<string>;

    crossings: ImportEdge[];

    /** Every specifier any of its files imports, plugin or not. */
    specifiers: { path: string; specifier: string }[];
};

/** PluginModules that leave this process, which no declaration in the contract narrows. */
const ESCAPES: Readonly<Record<string, string>> = {
    "child_process": "spawns a program that runs as this user, with this process's files, environment and network",
    "worker_threads": "runs code in a thread that shares this process's memory",
    "vm": "runs code this process never parsed",
    "cluster": "forks this process",
};

export function findImportViolations(root: string): ImportViolation[]
{
    const names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const contracts = names.filter((name) => existsSync(join(root, name, "plugin.ts")));

    const missingContracts: ImportViolation[] = names
        .filter((name) => !contracts.includes(name))
        .map((name) => ({
            rule: "contract" as const,
            message: `"${name}" is a plugin folder with no plugin.ts. Add its contract, or remove the folder.`,
        }));

    const plugins = contracts.map((name) => readPluginImports(root, name, contracts));

    return [...missingContracts, ...findUndeclared(withTestDependencies(plugins)), ...findDeepImports(withTestDependencies(plugins)), ...findCycles(plugins), ...findEscapes(plugins)];
}

/** What each plugin's tests must boot, following the chain. */
function withTestDependencies(plugins: readonly ImportsByPlugin[]): ImportsByPlugin[]
{
    const answers = new Map(plugins.map((plugin) => [plugin.name, plugin.answers]));
    const dependsOn = new Map(plugins.map((plugin) => [plugin.name, plugin.declared]));

    return plugins.map((plugin) =>
    {
        const reachable = new Set([...plugin.answers, ...plugin.declared]);
        const queue = [...reachable];

        while (queue.length > 0)
        {
            const next = queue.pop() as string;

            for (const set of [answers.get(next), dependsOn.get(next)])
            {
                for (const further of set ?? [])
                {
                    if (further !== plugin.name && !reachable.has(further))
                    {
                        reachable.add(further);
                        queue.push(further);
                    }
                }
            }
        }

        return { ...plugin, answers: reachable };
    });
}

function readPluginImports(root: string, name: string, names: readonly string[]): ImportsByPlugin
{
    const others = new Set(names.filter((other) => other !== name));
    const read = sourceFiles(root, name);
    const contract = readFileSync(join(root, name, "plugin.ts"), "utf8");
    const dependsOn = /dependsOn:\s*\[([^\]]*)\]/.exec(contract);

    const owners = new Set<string>();

    for (const block of [/listens:\s*\{/, /participates:\s*\{/])
    {
        const matched = block.exec(contract);

        if (matched === null)
        {
            continue;
        }

        for (const key of contract.slice(matched.index).matchAll(/"([a-z0-9-]+)\.[^"]+":/g))
        {
            if (others.has(key[1]!))
            {
                owners.add(key[1]!);
            }
        }
    }

    return {
        name,
        declared: new Set(dependsOn === null ? [] : [...dependsOn[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)),
        answers: owners,
        crossings: read.flatMap(({ path, source }) => edgesFrom(name, path, source, others)),
        specifiers: read.flatMap(({ path, source }) => [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => ({ path, specifier: match[1]! }))),
    };
}

function sourceFiles(root: string, name: string): { path: string; source: string }[]
{
    const pluginFolder = join(root, name);

    return readdirSync(pluginFolder, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) =>
        {
            const path = join(entry.parentPath, entry.name);

            return { path: path.replace(`${pluginFolder}/`, ""), source: readFileSync(path, "utf8") };
        });
}

function edgesFrom(name: string, path: string, source: string, others: ReadonlySet<string>): ImportEdge[]
{
    return [...source.matchAll(/from\s+"([^"]+)"/g)].flatMap((match) =>
    {
        const specifier = match[1]!;
        const alias = /^@plugins\/([^/]+)/.exec(specifier);

        if (alias !== null && others.has(alias[1]!))
        {
            return [{ from: path, to: alias[1]!, specifier }];
        }

        if (!specifier.startsWith("."))
        {
            return [];
        }

        const parts = [name, ...path.split("/").slice(0, -1), ...specifier.split("/")];
        const resolved: string[] = [];

        for (const part of parts)
        {
            if (part === "..")
            {
                resolved.pop();
            }
            else if (part !== ".")
            {
                resolved.push(part);
            }
        }

        const target = resolved[0];

        return target !== undefined && others.has(target) ? [{ from: path, to: target, specifier }] : [];
    });
}

function findUndeclared(plugins: readonly ImportsByPlugin[]): ImportViolation[]
{
    return plugins.flatMap((plugin) =>
        plugin.crossings
            .filter((crossing) =>
            {
                if (plugin.declared.has(crossing.to))
                {
                    return false;
                }

                return !(isTestPath(crossing.from)
                    && plugin.answers.has(crossing.to)
                    && crossing.specifier === `@plugins/${crossing.to}/plugin`);
            })
            .map((crossing) => ({
                rule: "undeclared" as const,
                message: `${plugin.name}/${crossing.from} imports "${crossing.specifier}" without declaring "${crossing.to}" in dependsOn.`,
            })),
    );
}

/** Whether a file is a test, which may reach one file more than the rest. */
function isTestPath(path: string): boolean
{
    return /(^|\/)tests?\//.test(path) || /\.test\.tsx?$/.test(path);
}

function findDeepImports(plugins: readonly ImportsByPlugin[]): ImportViolation[]
{
    return plugins.flatMap((plugin) =>
        plugin.crossings
            .filter((crossing) =>
            {
                if (crossing.specifier === `@plugins/${crossing.to}`)
                {
                    return false;
                }

                return !(isTestPath(crossing.from)
                    && (plugin.declared.has(crossing.to) || plugin.answers.has(crossing.to))
                    && crossing.specifier === `@plugins/${crossing.to}/plugin`);
            })
            .map((crossing) => ({
                rule: "deep" as const,
                message: `${plugin.name}/${crossing.from} reaches "${crossing.specifier}" instead of "@plugins/${crossing.to}".`,
            })),
    );
}

/** Plugins that import each other in a loop, tests excluded. */
function findCycles(plugins: readonly ImportsByPlugin[]): ImportViolation[]
{
    const edges = new Map(plugins.map((plugin) => [
        plugin.name,
        new Set(plugin.crossings.filter((crossing) => !isTestPath(crossing.from)).map((crossing) => crossing.to)),
    ]));
    const loops: ImportViolation[] = [];
    const open = new Set<string>();
    const done = new Set<string>();

    function walk(name: string, trail: readonly string[]): void
    {
        if (done.has(name))
        {
            return;
        }

        if (open.has(name))
        {
            loops.push({
                rule: "cycle",
                message: `Plugins import each other in a loop: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}.`,
            });

            return;
        }

        open.add(name);

        for (const target of edges.get(name) ?? [])
        {
            walk(target, [...trail, name]);
        }

        open.delete(name);
        done.add(name);
    }

    for (const plugin of plugins)
    {
        walk(plugin.name, []);
    }

    return loops;
}

/** Imports that leave the process, which nothing in the contract declares. */
function findEscapes(plugins: readonly ImportsByPlugin[]): ImportViolation[]
{
    return plugins.flatMap((plugin) =>
        plugin.specifiers.flatMap(({ path, specifier }) =>
        {
            const module = /^node:([a-z_]+)/.exec(specifier)?.[1] ?? "";
            const why = ESCAPES[module];

            return why === undefined ? [] : [{
                rule: "escape" as const,
                message: `${plugin.name}/${path} imports "${specifier}", which ${why}. No key in the contract narrows a process the way outbound narrows a host, so this crossing is declared nowhere. Move it behind a service the application supplies, or name this plugin in "leaving" to say the crossing is meant.`,
            }];
        }),
    );
}

export type DuplicateSignature = {
    signature: string;
    plugins: readonly string[];
    files: readonly string[];
};

/** A util two plugins wrote for themselves, matched by name and signature. */
export function findSharedNames(root: string): DuplicateSignature[]
{
    const owners = new Map<string, { plugins: Set<string>; files: string[] }>();

    for (const plugin of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()))
    {
        const utilsFolder = join(root, plugin.name, "utils");

        if (!existsSync(utilsFolder))
        {
            continue;
        }

        for (const entry of readdirSync(utilsFolder, { withFileTypes: true, recursive: true }))
        {
            if (!entry.isFile() || !/\.tsx?$/.test(entry.name))
            {
                continue;
            }

            const path = join(entry.parentPath, entry.name);

            for (const method of readFileSync(path, "utf8").matchAll(/^ {4}(?:readonly )?([a-zA-Z][a-zA-Z0-9]*)(\([^)]*\)\s*:\s*[^\n{]+)/gm))
            {
                const signature = `${method[1]!}${method[2]!.replace(/\s+/g, " ").trim()}`;
                const held = owners.get(signature) ?? { plugins: new Set<string>(), files: [] };

                held.plugins.add(plugin.name);
                held.files.push(relative(root, path));
                owners.set(signature, held);
            }
        }
    }

    return [...owners]
        .filter(([, held]) => held.plugins.size > 1)
        .map(([signature, held]) => ({ signature, plugins: [...held.plugins].sort(), files: held.files }));
}

export type SplitVocabulary = {
    name: string;
    plugins: readonly string[];
    files: readonly string[];
    shared: readonly string[];
    apart: readonly string[];
};

export type CopiedVocabulary = {
    name: string;
    owner: string;
    copier: string;
    file: string;
    values: readonly string[];
};

/** One word naming two closed sets that are nearly, but not quite, the same. */
export function findSplitVocabulary(root: string): SplitVocabulary[]
{
    const byName = new Map<string, { plugin: string; file: string; values: string[] }[]>();

    for (const plugin of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()))
    {
        for (const entry of readdirSync(join(root, plugin.name), { withFileTypes: true, recursive: true }))
        {
            if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.parentPath.includes("tests"))
            {
                continue;
            }

            const path = join(entry.parentPath, entry.name);

            for (const found of readFileSync(path, "utf8").matchAll(/(?:export )?const (\w+) = z\.enum\(\[([^\]]*)\]/g))
            {
                const values = [...(found[2] ?? "").matchAll(/"([^"]+)"/g)].map((one) => one[1] ?? "").sort();
                const held = byName.get(found[1] ?? "") ?? [];

                held.push({ plugin: plugin.name, file: relative(root, path), values });
                byName.set(found[1] ?? "", held);
            }
        }
    }

    return [...byName].flatMap(([name, held]) => differingValues(root, name, held));
}

function differingValues(root: string, name: string, held: { plugin: string; file: string; values: string[] }[]): SplitVocabulary[]
{
    const split: SplitVocabulary[] = [];

    for (let one = 0; one < held.length; one += 1)
    {
        for (let two = one + 1; two < held.length; two += 1)
        {
            const first = held[one]!;
            const second = held[two]!;

            if (first.plugin === second.plugin)
            {
                continue;
            }

            const shared = first.values.filter((value) => second.values.includes(value));
            const apart = [
                ...first.values.filter((value) => !second.values.includes(value)),
                ...second.values.filter((value) => !first.values.includes(value)),
            ];

            if (shared.length === 0 || apart.length === 0 || !importsPlugin(root, first.plugin, second.plugin))
            {
                continue;
            }

            split.push({
                name,
                plugins: [first.plugin, second.plugin],
                files: [first.file, second.file],
                shared,
                apart,
            });
        }
    }

    return split;
}

export function findCopiedVocabulary(root: string): CopiedVocabulary[]
{
    const owners = new Map<string, { name: string; plugin: string }>();
    const inline: { values: string; plugin: string; file: string }[] = [];

    for (const plugin of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()))
    {
        for (const entry of readdirSync(join(root, plugin.name), { withFileTypes: true, recursive: true }))
        {
            if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.parentPath.includes("tests"))
            {
                continue;
            }

            const path = join(entry.parentPath, entry.name);
            const source = readFileSync(path, "utf8");

            for (const found of source.matchAll(/(?:export )?const (\w+) = z\.enum\(\[([^\]]*)\]/g))
            {
                owners.set(exportedMembers(found[2] ?? ""), { name: found[1] ?? "", plugin: plugin.name });
            }

            for (const found of source.matchAll(/^\s+\w+:\s*z\.enum\(\[([^\]]*)\]/gm))
            {
                inline.push({ values: exportedMembers(found[1] ?? ""), plugin: plugin.name, file: relative(root, path) });
            }
        }
    }

    return inline.flatMap((one) =>
    {
        const owner = owners.get(one.values);

        if (owner === undefined || owner.plugin === one.plugin)
        {
            return [];
        }

        return [{
            name: owner.name,
            owner: owner.plugin,
            copier: one.plugin,
            file: one.file,
            values: one.values.split(","),
        }];
    });
}

function exportedMembers(written: string): string
{
    return [...written.matchAll(/"([^"]+)"/g)].map((one) => one[1] ?? "").sort().join(",");
}

function importsPlugin(root: string, one: string, two: string): boolean
{
    return dependsOn(root, one, two) || dependsOn(root, two, one);
}

function dependsOn(root: string, from: string, on: string): boolean
{
    const contract = join(root, from, "plugin.ts");

    if (!existsSync(contract))
    {
        return false;
    }

    const declared = /dependsOn\s*:\s*\[([^\]]*)\]/.exec(readFileSync(contract, "utf8"))?.[1] ?? "";

    return declared.includes(`"${on}"`);
}
