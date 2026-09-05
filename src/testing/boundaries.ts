import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type ImportEdge = {
    from: string;
    to: string;
    specifier: string;
};

export type ImportViolation = {
    rule: "undeclared" | "deep" | "cycle" | "contract";
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

    return [...missingContracts, ...undeclared(needed(plugins)), ...deep(needed(plugins)), ...findCycles(plugins)];
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
function needed(plugins: readonly PluginImports[]): PluginImports[]
{
    const answers = new Map(plugins.map((one) => [one.name, one.answers]));
    const declared = new Map(plugins.map((one) => [one.name, one.declared]));

    return plugins.map((one) =>
    {
        // Seeded from both: a test boots what this plugin hears *and* what it
        // depends on, and then whatever those need in turn. Seeding only from
        // what it hears leaves a three-deep dependency chain untestable
        // without writing a dependency that is not one.
        const reached = new Set([...one.answers, ...one.declared]);
        const walking = [...reached];

        while (walking.length > 0)
        {
            const next = walking.pop() as string;

            for (const set of [answers.get(next), declared.get(next)])
            {
                for (const further of set ?? [])
                {
                    if (further !== one.name && !reached.has(further))
                    {
                        reached.add(further);
                        walking.push(further);
                    }
                }
            }
        }

        return { ...one, answers: reached };
    });
}

function read(root: string, name: string, names: readonly string[]): PluginImports
{
    const others = new Set(names.filter((one) => one !== name));
    const contract = readFileSync(join(root, name, "plugin.ts"), "utf8");
    const found = /dependsOn:\s*\[([^\]]*)\]/.exec(contract);

    // An event or hook key is "<plugin>.<something>", so what a plugin
    // answers is the first segment of every key it listens to or joins.
    const answering = new Set<string>();

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
                answering.add(key[1]!);
            }
        }
    }

    return {
        name,
        declared: new Set(found === null ? [] : [...found[1]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!)),
        answers: answering,
        crossings: files(root, name).flatMap(({ path, source }) => crossings(name, path, source, others)),
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
function crossings(name: string, path: string, source: string, others: ReadonlySet<string>): ImportEdge[]
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
        const walked: string[] = [];

        for (const part of parts)
        {
            if (part === "..")
            {
                walked.pop();
            }
            else if (part !== ".")
            {
                walked.push(part);
            }
        }

        const target = walked[0];

        return target !== undefined && others.has(target) ? [{ from: path, to: target, specifier }] : [];
    });
}

function undeclared(plugins: readonly PluginImports[]): ImportViolation[]
{
    return plugins.flatMap((one) =>
        one.crossings
            .filter((crossing) =>
            {
                if (one.declared.has(crossing.to))
                {
                    return false;
                }

                // A test of a listener boots what it listens to. That is not
                // a dependency, and writing one to satisfy this check would
                // put a lie in the contract.
                return !(tested(crossing.from)
                    && one.answers.has(crossing.to)
                    && crossing.specifier === `@plugins/${crossing.to}/plugin`);
            })
            .map((crossing) => ({
                rule: "undeclared" as const,
                message: `${one.name}/${crossing.from} imports "${crossing.specifier}" without declaring "${crossing.to}" in dependsOn.`,
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
function tested(path: string): boolean
{
    return /(^|\/)tests?\//.test(path) || /\.test\.tsx?$/.test(path);
}

function deep(plugins: readonly PluginImports[]): ImportViolation[]
{
    return plugins.flatMap((one) =>
        one.crossings
            .filter((crossing) =>
            {
                if (crossing.specifier === `@plugins/${crossing.to}`)
                {
                    return false;
                }

                // A test may name a declared dependency's contract, and only
                // its contract: everything below it is still private.
                return !(tested(crossing.from)
                    && (one.declared.has(crossing.to) || one.answers.has(crossing.to))
                    && crossing.specifier === `@plugins/${crossing.to}/plugin`);
            })
            .map((crossing) => ({
                rule: "deep" as const,
                message: `${one.name}/${crossing.from} reaches "${crossing.specifier}" instead of "@plugins/${crossing.to}".`,
            })),
    );
}

function findCycles(plugins: readonly PluginImports[]): ImportViolation[]
{
    const edges = new Map(plugins.map((one) => [one.name, new Set(one.crossings.map((crossing) => crossing.to))]));
    const found: ImportViolation[] = [];
    const walking = new Set<string>();
    const done = new Set<string>();

    function walk(name: string, trail: readonly string[]): void
    {
        if (done.has(name))
        {
            return;
        }

        if (walking.has(name))
        {
            found.push({
                rule: "cycle",
                message: `Plugins import each other in a loop: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}.`,
            });

            return;
        }

        walking.add(name);

        for (const target of edges.get(name) ?? [])
        {
            walk(target, [...trail, name]);
        }

        walking.delete(name);
        done.add(name);
    }

    for (const one of plugins)
    {
        walk(one.name, []);
    }

    return found;
}
