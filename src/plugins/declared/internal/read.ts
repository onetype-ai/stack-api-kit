import type { Plugin } from "../../kernel/api";

/** One route as declared: what reaches it, and what it asks of the caller. */
export type DeclaredRoute = {
    readonly method: string;
    readonly path: string;
    readonly describe: string;

    /** Whether an unauthenticated caller may reach it; absent in a definition means no. */
    readonly public: boolean;
    readonly requires: readonly string[];
    readonly limit?: { readonly requests: number; readonly seconds: number };
};

/** A name carrying a sentence, which is how events, channels, hooks and commands read. */
export type DeclaredEntry = {
    readonly name: string;
    readonly describe: string;
};

/** One command, which unlike an event names what the caller must hold. */
export type DeclaredCommand = DeclaredEntry & {
    readonly requires: readonly string[];
};

/** Which claim decides whose rows a plugin reads, and the tables it narrows. */
export type DeclaredScope = {
    readonly describe: string;
    readonly claim: string;
    readonly tables: readonly string[];
};

/** Everything one plugin declares, as data rather than source. */
export type Declaration = {
    readonly name: string;
    readonly version: string;
    readonly describe: string;
    readonly dependsOn: readonly string[];
    readonly routes: readonly DeclaredRoute[];
    readonly emits: readonly DeclaredEntry[];
    readonly listens: readonly DeclaredEntry[];
    readonly channels: readonly DeclaredEntry[];
    readonly hooks: readonly DeclaredEntry[];
    readonly participates: readonly DeclaredEntry[];
    readonly commands: readonly DeclaredCommand[];
    readonly tables: readonly string[];
    readonly scope?: DeclaredScope;
    readonly allowedHosts: readonly string[] | "anywhere";
    readonly migrations?: string;
    readonly config: boolean;
    readonly services: boolean;
    readonly setup: boolean;
    readonly teardown: boolean;
};

// A record of describable things reads the same whether it holds events,
// channels, hooks or participations, so one reader covers all four.
function entriesOf(held: unknown): DeclaredEntry[]
{
    if (held === undefined || held === null || typeof held !== "object")
    {
        return [];
    }

    return Object.entries(held as Record<string, { describe?: unknown }>)
        .map(([name, held]) => ({
            name,
            describe: typeof held?.describe === "string" ? held.describe : "",
        }))
        .sort((first, second) => first.name.localeCompare(second.name));
}

function routesOf(declared: unknown): DeclaredRoute[]
{
    if (!Array.isArray(declared))
    {
        return [];
    }

    return declared.map((route: Record<string, unknown>) => {
        const limit = route["limit"] as { requests?: unknown; seconds?: unknown } | undefined;

        return {
            method: typeof route["method"] === "string" ? route["method"] : "",
            path: typeof route["path"] === "string" ? route["path"] : "",
            describe: typeof route["describe"] === "string" ? route["describe"] : "",

            // absent means no, the way the kernel reads it
            public: route["public"] === true,
            requires: Array.isArray(route["requires"]) ? [...(route["requires"] as string[])] : [],
            ...(typeof limit?.requests === "number" && typeof limit.seconds === "number"
                ? { limit: { requests: limit.requests, seconds: limit.seconds } }
                : {}),
        };
    });
}

function commandsOf(held: unknown): DeclaredCommand[]
{
    if (held === undefined || held === null || typeof held !== "object")
    {
        return [];
    }

    return Object.entries(held as Record<string, { describe?: unknown; requires?: unknown }>)
        .map(([name, command]) => ({
            name,
            describe: typeof command?.describe === "string" ? command.describe : "",
            requires: Array.isArray(command?.requires) ? [...(command.requires as string[])] : [],
        }))
        .sort((first, second) => first.name.localeCompare(second.name));
}

function declarationFor(plugin: Plugin): Declaration
{
    const definition = plugin.definition as unknown as Record<string, unknown>;
    const scope = definition["scope"] as
        | { describe?: unknown; claim?: unknown; tables?: Record<string, string> }
        | undefined;

    const hosts = definition["allowedHosts"];

    return {
        name: plugin.name,
        version: typeof definition["version"] === "string" ? definition["version"] : "",
        describe: typeof definition["describe"] === "string" ? definition["describe"] : "",
        dependsOn: Array.isArray(definition["dependsOn"]) ? [...(definition["dependsOn"] as string[])] : [],
        routes: routesOf(definition["routes"]),
        emits: entriesOf(definition["emits"]),
        listens: entriesOf(definition["listens"]),
        channels: entriesOf(definition["channels"]),
        hooks: entriesOf(definition["hooks"]),
        participates: entriesOf(definition["participates"]),
        commands: commandsOf(definition["commands"]),
        tables: Object.keys((definition["tables"] as Record<string, unknown>) ?? {}).sort(),
        ...(scope !== undefined
            ? {
                scope: {
                    describe: typeof scope.describe === "string" ? scope.describe : "",
                    claim: typeof scope.claim === "string" ? scope.claim : "",
                    tables: Object.keys(scope.tables ?? {}).sort(),
                },
            }
            : {}),
        allowedHosts: hosts === "anywhere" ? "anywhere" : Array.isArray(hosts) ? [...(hosts as string[])] : [],
        ...(typeof definition["migrations"] === "string" ? { migrations: definition["migrations"] } : {}),

        // whether it has one, not what it is: a schema is its own contract
        config: definition["config"] !== undefined,
        services: definition["services"] !== undefined,
        setup: definition["setup"] !== undefined,
        teardown: definition["teardown"] !== undefined,
    };
}

/** Reads what the given plugins declare; a name narrows it to that one. */
export function declarationsOf(plugins: readonly Plugin[], name?: string): Declaration[]
{
    return plugins
        .filter((plugin) => name === undefined || plugin.name === name)
        .map(declarationFor)
        .sort((first, second) => first.name.localeCompare(second.name));
}
