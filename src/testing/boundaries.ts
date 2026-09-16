import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** One file importing another plugin: `from` is relative to the importing plugin's folder, `to` is the plugin name reached, `specifier` the text as written. */
export type ImportEdge = {
    from: string;
    to: string;
    specifier: string;
};

/** One crossing the boundaries refuse, `rule` saying which: an undeclared dependency, a reach past `@plugins/<name>`, an import loop, a folder with no plugin.ts, a process escape, or a util written twice. */
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

/** Imports that leave this process, which no declaration in the contract narrows. */
const ESCAPES: Readonly<Record<string, string>> = {
    "child_process": "spawns a program that runs as this user, with this process's files, environment and network",
    "worker_threads": "runs code in a thread that shares this process's memory",
    "vm": "runs code this process never parsed",
    "cluster": "forks this process",
};

/** Reads every plugin folder under `root` by regex, never by compiling, and answers what crosses a boundary; tests are excused the deep import of a dependency's `plugin.ts`. */
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
            const consequence = ESCAPES[module];

            return consequence === undefined ? [] : [{
                rule: "escape" as const,
                message: `${plugin.name}/${path} imports "${specifier}", which ${consequence}. No key in the contract narrows a process the way outbound narrows a host, so this crossing is declared nowhere. Move it behind a service the application supplies, or name this plugin in "leaving" to say the crossing is meant.`,
            }];
        }),
    );
}

/** One method name and signature that more than one plugin wrote for itself under its own `utils/`, with every file holding a copy. */
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
                const owner = owners.get(signature) ?? { plugins: new Set<string>(), files: [] };

                owner.plugins.add(plugin.name);
                owner.files.push(relative(root, path));
                owners.set(signature, owner);
            }
        }
    }

    return [...owners]
        .filter(([, owner]) => owner.plugins.size > 1)
        .map(([signature, owner]) => ({ signature, plugins: [...owner.plugins].sort(), files: owner.files }));
}

/** One enum name two plugins each declare with overlapping but unequal members: `shared` is in both, `apart` in only one. */
export type SplitVocabulary = {
    name: string;
    plugins: readonly string[];
    files: readonly string[];
    shared: readonly string[];
    apart: readonly string[];
};

/** An inline `z.enum` whose members exactly match a named enum another plugin exports, so `values` is a copy with no name and nothing compares the two. */
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
                const values = [...(found[2] ?? "").matchAll(/"([^"]+)"/g)].map((member) => member[1] ?? "").sort();
                const declarations = byName.get(found[1] ?? "") ?? [];

                declarations.push({ plugin: plugin.name, file: relative(root, path), values });
                byName.set(found[1] ?? "", declarations);
            }
        }
    }

    return [...byName].flatMap(([name, declarations]) => differingValues(root, name, declarations));
}

function differingValues(root: string, name: string, declarations: { plugin: string; file: string; values: string[] }[]): SplitVocabulary[]
{
    const split: SplitVocabulary[] = [];

    for (let index = 0; index < declarations.length; index += 1)
    {
        for (let other = index + 1; other < declarations.length; other += 1)
        {
            const declaration = declarations[index]!;
            const otherDeclaration = declarations[other]!;

            if (declaration.plugin === otherDeclaration.plugin)
            {
                continue;
            }

            const shared = declaration.values.filter((value) => otherDeclaration.values.includes(value));
            const apart = [
                ...declaration.values.filter((value) => !otherDeclaration.values.includes(value)),
                ...otherDeclaration.values.filter((value) => !declaration.values.includes(value)),
            ];

            if (shared.length === 0 || apart.length === 0 || !eitherDependsOn(root, declaration.plugin, otherDeclaration.plugin))
            {
                continue;
            }

            split.push({
                name,
                plugins: [declaration.plugin, otherDeclaration.plugin],
                files: [declaration.file, otherDeclaration.file],
                shared,
                apart,
            });
        }
    }

    return split;
}

/** Finds inline `z.enum` members that exactly match an enum another plugin names, ignoring tests; an identical set within the same plugin is not reported. */
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

    return inline.flatMap((copy) =>
    {
        const owner = owners.get(copy.values);

        if (owner === undefined || owner.plugin === copy.plugin)
        {
            return [];
        }

        return [{
            name: owner.name,
            owner: owner.plugin,
            copier: copy.plugin,
            file: copy.file,
            values: copy.values.split(","),
        }];
    });
}

function exportedMembers(written: string): string
{
    return [...written.matchAll(/"([^"]+)"/g)].map((member) => member[1] ?? "").sort().join(",");
}

/** Whether either plugin declares the other in dependsOn, in either direction. */
function eitherDependsOn(root: string, plugin: string, other: string): boolean
{
    return dependsOn(root, plugin, other) || dependsOn(root, other, plugin);
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

/** One method reaching a scoped table without the narrowing its scope declares. */
export type UnscopedReach = {
    plugin: string;
    file: string;
    table: string;
    message: string;
};

/** The calls that narrow a query to one tenant, and the one that declares every tenant was intended. */
const NARROWING = /\b(scoped|stamped|forScope|unscoped)\s*[<(]/u;

/** Reads each plugin's declared scope, then answers where its tables are reached without narrowing: such a query returns every tenant's rows, and nothing at compile time, boot or request says so. */
export function findUnscopedReach(root: string): UnscopedReach[]
{
    if (!existsSync(root))
    {
        return [];
    }

    const reached: UnscopedReach[] = [];

    for (const entry of readdirSync(root, { withFileTypes: true }))
    {
        if (!entry.isDirectory())
        {
            continue;
        }

        const contract = join(root, entry.name, "plugin.ts");

        if (!existsSync(contract))
        {
            continue;
        }

        // The tables map, however the contract is laid out: a scope written on one
        // line closes on that line, one written out closes on its own.
        const scope = /scope\s*:[\s\S]*?tables\s*:\s*\{([^}]*)\}/u.exec(readFileSync(contract, "utf8"))?.[1];
        const tables = [...(scope ?? "").matchAll(/(\w+)\s*:\s*"/gu)]
            .map((named) => named[1] ?? "")
            .filter((name) => name !== "");

        if (tables.length === 0)
        {
            continue;
        }

        // Where a plugin writes sqliteTable("<sql name>", …), so a raw query
        // naming the database's spelling can be found as well as the variable.
        let tableSource = "";

        for (const file of readdirSync(join(root, entry.name), { withFileTypes: true, recursive: true }))
        {
            if (file.isFile() && file.name.endsWith(".ts"))
            {
                tableSource += readFileSync(join(file.parentPath, file.name), "utf8");
            }
        }

        for (const file of readdirSync(join(root, entry.name), { withFileTypes: true, recursive: true }))
        {
            if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts"))
            {
                continue;
            }

            const where = join(file.parentPath, file.name);
            const source = readFileSync(where, "utf8");

            for (const table of tables)
            {
                // A query, not a mention: `.from(notes)` reaches rows, while
                // the word "notes" in a sentence reaches nothing. Matching the
                // bare name reported prose as a leak and taught readers to
                // ignore the one check that catches a tenant breach.
                // The SQL name too: raw SQL names the table the database knows,
                // never the drizzle variable, so a `sql\`select … from x\`` was
                // invisible to a check watching only the builder.
                const sqlName = new RegExp(`\\b${table}\\s*[:=]\\s*\\w*[Tt]able\\s*\\(\\s*["'\`]([^"'\`]+)`, "u").exec(tableSource)?.[1];

                const queries = [
                    ...source.matchAll(new RegExp(`\\.(?:from|insert|update|delete)\\s*\\(\\s*${table}\\b`, "gu")),
                    ...(sqlName === undefined ? [] : source.matchAll(new RegExp(`\\b(?:from|into|update|join)\\s+"?${sqlName}"?\\b`, "giu"))),
                ];

                if (queries.length === 0)
                {
                    continue;
                }

                // Each query is judged by the function it sits in, since the
                // condition is usually built a line or two above it. Reading
                // the whole file instead would let one careful query excuse
                // every forgetful one beside it.
                const unnarrowed = queries.filter((query) =>
                {
                    const opened = source.lastIndexOf("\n    {", query.index);
                    const closed = source.indexOf("\n    }", query.index);

                    return !NARROWING.test(source.slice(opened === -1 ? 0 : opened, closed === -1 ? undefined : closed));
                });

                if (unnarrowed.length > 0)
                {
                    const times = unnarrowed.length === 1 ? "" : ` in ${String(unnarrowed.length)} places`;

                    reached.push({
                        plugin: entry.name,
                        file: relative(root, where),
                        table,
                        message: `${relative(root, where)}: queries "${table}"${times}, which "${entry.name}" scopes, and narrows by nothing. Every tenant's rows answer. Pass ctx.scoped("${table}") to where, or ctx.forScope(claim) for a caller the request does not name.`,
                    });
                }
            }
        }
    }

    return reached;
}

