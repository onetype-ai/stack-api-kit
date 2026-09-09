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

type PluginImports = {
    name: string;
    declared: Set<string>;

    /**
     * Plugins whose events or hooks this one answers.
     *
     * Not dependencies: hearing is not depending, and the kernel adds no edge
     * for it. But a test still has to boot the plugin that emits, or there is
     * nothing to hear, so a test may name its contract exactly as a test of a
     * dependency may.
     */
    answers: Set<string>;

    crossings: ImportEdge[];

    /** Every specifier any of its files imports, plugin or not. */
    specifiers: { path: string; specifier: string }[];
};

/**
 * Modules that leave this process, which no declaration in the contract narrows.
 *
 * `outbound` names hosts, and the kernel refuses one that is private, plain or
 * carries a credential. None of that reaches a program: a spawned command runs
 * as this user with this process's files, environment and network, and a thread
 * or a vm runs code the kit never parsed. Naming them here is not a policy about
 * whether a plugin may do it, only that the contract cannot pretend it did not.
 */
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

    // A folder with no contract is reported, not thrown: a half-built plugin
    // is the commonest reason to run this check, and a raw ENOENT naming a
    // path inside the kit tells its author nothing about their own folder.
    const contracts = names.filter((name) => existsSync(join(root, name, "plugin.ts")));

    const missingContracts: ImportViolation[] = names
        .filter((name) => !contracts.includes(name))
        .map((name) => ({
            rule: "contract" as const,
            message: `"${name}" is a plugin folder with no plugin.ts. Add its contract, or remove the folder.`,
        }));

    const plugins = contracts.map((name) => read(root, name, contracts));

    return [...missingContracts, ...findUndeclared(withTestDependencies(plugins)), ...deep(withTestDependencies(plugins)), ...findCycles(plugins), ...findEscapes(plugins)];
}

/**
 * What each plugin's tests must boot, following the chain.
 *
 * A listener has to boot what it hears. But that emitter may itself be a
 * listener, and cannot start without the plugin *it* hears: a test two hops
 * down the chain has to boot all three. Refusing that made the checker decide
 * an architecture, which is backwards.
 *
 * Dependencies are not widened this way: only what a test has to assemble.
 */
function withTestDependencies(plugins: readonly PluginImports[]): PluginImports[]
{
    const answers = new Map(plugins.map((plugin) => [plugin.name, plugin.answers]));
    const dependsOn = new Map(plugins.map((plugin) => [plugin.name, plugin.declared]));

    return plugins.map((plugin) =>
    {
        // Seeded from both: a test boots what this plugin hears *and* what it
        // depends on, and then whatever those need in turn. Seeding only from
        // what it hears leaves a three-deep dependency chain untestable
        // without writing a dependency that is not one.
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

function read(root: string, name: string, names: readonly string[]): PluginImports
{
    const others = new Set(names.filter((other) => other !== name));
    const read = files(root, name);
    const contract = readFileSync(join(root, name, "plugin.ts"), "utf8");
    const dependsOn = /dependsOn:\s*\[([^\]]*)\]/.exec(contract);

    // An event or hook key is "<plugin>.<something>", so what a plugin
    // answers is the first segment of every key it listens to or joins.
    const owners = new Set<string>();

    for (const block of [/listens:\s*\{/, /participates:\s*\{/])
    {
        const at = block.exec(contract);

        if (at === null)
        {
            continue;
        }

        for (const key of contract.slice(at.index).matchAll(/"([a-z0-9-]+)\.[^"]+":/g))
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

function files(root: string, name: string): { path: string; source: string }[]
{
    const at = join(root, name);

    return readdirSync(at, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) =>
        {
            const path = join(entry.parentPath, entry.name);

            return { path: path.replace(`${at}/`, ""), source: readFileSync(path, "utf8") };
        });
}

// A specifier is resolved against the file that wrote it rather than matched as
// text: "../../other/thing" reaches the same private file an alias would, and a
// rule reading the alias alone calls that clean.
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

function findUndeclared(plugins: readonly PluginImports[]): ImportViolation[]
{
    return plugins.flatMap((plugin) =>
        plugin.crossings
            .filter((crossing) =>
            {
                if (plugin.declared.has(crossing.to))
                {
                    return false;
                }

                // A test of a listener boots what it listens to. That is not
                // a dependency, and writing one to satisfy this check would
                // put a lie in the contract.
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

/**
 * Whether a file is a test, which may reach one file more than the rest.
 *
 * A plugin with a dependency has to boot it to test itself, and a contract is
 * not reachable through `index.ts`: what a consumer imports is the public API,
 * and what a kernel takes is the plugin. Refusing this left `tests.md`'s "a
 * plugin tests itself in its own tests/" impossible for anything with a
 * dependency.
 */
function isTestPath(path: string): boolean
{
    return /(^|\/)tests?\//.test(path) || /\.test\.tsx?$/.test(path);
}

function deep(plugins: readonly PluginImports[]): ImportViolation[]
{
    return plugins.flatMap((plugin) =>
        plugin.crossings
            .filter((crossing) =>
            {
                if (crossing.specifier === `@plugins/${crossing.to}`)
                {
                    return false;
                }

                // A test may name a declared dependency's contract, and only
                // its contract: everything below it is still private.
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

/**
 * Plugins that import each other in a loop, tests excluded.
 *
 * A test boots what its plugin hears, and an emitter may depend on the plugin
 * that hears it: that is a cycle on paper and never at runtime, since nothing
 * a deployment loads imports the other way. Counting tests reported it anyway,
 * which sent an author redesigning an architecture that was already sound.
 */
function findCycles(plugins: readonly PluginImports[]): ImportViolation[]
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

    for (const one of plugins)
    {
        walk(one.name, []);
    }

    return loops;
}

/**
 * Imports that leave the process, which nothing in the contract declares.
 *
 * The kernel refuses an outbound host that is plain, private or carries a
 * credential, and says so by name. A spawned program is reached by none of
 * that, so today it passes in silence: the one thing the whole stack rests on
 * — undeclared does not exist — stops at the network.
 *
 * This catches the declaration, not the behaviour: a require, or a dependency
 * that spawns on this plugin's behalf, still goes unseen. It turns the common
 * case from a silent omission into a loud one, which is what the rest of the
 * kernel does.
 *
 * Tests are read too. A test that spawns leaves the process exactly as
 * production does, and the file it runs from does not change what it inherits.
 */
function findEscapes(plugins: readonly PluginImports[]): ImportViolation[]
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

export type SharedName = {
    signature: string;
    plugins: readonly string[];
    files: readonly string[];
};

/**
 * A util two plugins wrote for themselves, matched by name and signature.
 *
 * Bodies are not compared, and comparing them was tried first: of sixteen
 * names written in more than one plugin, exactly two had identical bodies and
 * both were one line — `randomUUID()` and a bearer header. The ones that
 * mattered all differed. Three plugins each wrote `searchable(raw: string):
 * string` and the three disagree: "Café, s.r.o." folds to "cafe s r o" in two
 * of them and "cafe, s.r.o." in the third, so a row written by one is not
 * found by another. Same name, same types, three meanings, and nothing
 * compared them.
 *
 * So the signature is the claim: a function taking these types and answering
 * this one is answering the same question, however it is written. A pair that
 * genuinely differs says so by taking different types or answering a different
 * one, which is the honest way to hold two meanings apart.
 *
 * Only `utils/` is read. A service knows its domain and is meant to differ; a
 * util is pure by definition, and a pure function written twice is one that
 * drifts in silence.
 */
export function findSharedNames(root: string): SharedName[]
{
    const owners = new Map<string, { plugins: Set<string>; files: string[] }>();

    for (const plugin of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()))
    {
        const at = join(root, plugin.name, "utils");

        if (!existsSync(at))
        {
            continue;
        }

        for (const entry of readdirSync(at, { withFileTypes: true, recursive: true }))
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

/**
 * One word naming two closed sets that are nearly, but not quite, the same.
 *
 * Two plugins that both call something a Role and disagree about what a Role
 * may be hold one idea in two places, and nothing compares them: each parses
 * its own and passes. The day one gains a value, the other rejects a payload
 * carrying it and answers as though the whole response were malformed.
 *
 * Sets that share nothing are left alone. A word can mean two things in two
 * domains, and often does; what cannot stand is two answers to one question.
 */
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

    return [...byName].flatMap(([name, held]) => compare(root, name, held));
}

function compare(root: string, name: string, held: { plugin: string; file: string; values: string[] }[]): SplitVocabulary[]
{
    const found: SplitVocabulary[] = [];

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

            if (shared.length === 0 || apart.length === 0 || !reaches(root, first.plugin, second.plugin))
            {
                continue;
            }

            found.push({
                name,
                plugins: [first.plugin, second.plugin],
                files: [first.file, second.file],
                shared,
                apart,
            });
        }
    }

    return found;
}

export function findCopiedVocabulary(root: string): CopiedVocabulary[]
{
    const named = new Map<string, { name: string; plugin: string }>();
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
                named.set(membersOf(found[2] ?? ""), { name: found[1] ?? "", plugin: plugin.name });
            }

            for (const found of source.matchAll(/^\s+\w+:\s*z\.enum\(\[([^\]]*)\]/gm))
            {
                inline.push({ values: membersOf(found[1] ?? ""), plugin: plugin.name, file: relative(root, path) });
            }
        }
    }

    return inline.flatMap((one) =>
    {
        const owner = named.get(one.values);

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

function membersOf(written: string): string
{
    return [...written.matchAll(/"([^"]+)"/g)].map((one) => one[1] ?? "").sort().join(",");
}

function reaches(root: string, one: string, two: string): boolean
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
