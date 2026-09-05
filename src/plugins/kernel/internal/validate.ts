import type { Plugin } from "./contract";
import type { KernelFault } from "./faults";
import * as names from "./names";
import { filters } from "./output";

/** One thing wrong, and everything needed to fix it. */
export type ContractProblem = {
    code: KernelFault["code"];
    plugin: string;
    message: string;
};

type Report = (code: KernelFault["code"], plugin: string, message: string) => void;

type Claimed = {
    routes: Map<string, string>;
    events: Map<string, string>;
    hooks: Map<string, string>;
    commands: Map<string, string>;
    permissions: Map<string, string>;
    tables: Map<string, string>;
};

/**
 * Checks every contract, and reports everything wrong rather than the first.
 *
 * A project with four mistakes should learn all four in one run rather than
 * in four runs, each ending at a different one.
 */
export function validate(plugins: readonly Plugin[], config: Readonly<Record<string, unknown>>): ContractProblem[]
{
    const wrong: ContractProblem[] = [];
    const say: Report = (code, plugin, message) =>
    {
        wrong.push({ code, plugin, message });
    };

    const by = new Map<string, Plugin>();

    for (const plugin of plugins)
    {
        if (by.has(plugin.name))
        {
            say("DUPLICATE_PLUGIN", plugin.name, `Two plugins are named "${plugin.name}". A name is what everything else refers to, so it must be unique.`);

            continue;
        }

        by.set(plugin.name, plugin);
    }

    const owned: Claimed = {
        routes: new Map(),
        events: new Map(),
        hooks: new Map(),
        commands: new Map(),
        permissions: new Map(),
        tables: new Map(),
    };

    for (const [name, plugin] of by)
    {
        checkOwn(name, plugin, owned, say);
    }

    for (const [name, plugin] of by)
    {
        checkReferences(name, plugin, by, owned, say);
        checkConfig(name, plugin, config, say);
    }

    checkCycles(by, say);

    return wrong;
}

/** What a plugin declares, and whether anyone claimed it first. */
function checkOwn(name: string, plugin: Plugin, owned: Claimed, say: Report): void
{
    const claim = (kind: keyof Claimed, key: string, code: KernelFault["code"], label: string): void =>
    {
        const first = owned[kind].get(key);

        if (first !== undefined)
        {
            say(code, name, `${label} "${key}" is already declared by "${first}". Two plugins cannot own one name.`);

            return;
        }

        owned[kind].set(key, name);
    };

    for (const key of Object.keys(plugin.definition.permissions ?? {}))
    {
        checkNamespaced(name, key, "permission", say) && claim("permissions", key, "DUPLICATE_PERMISSION", "Permission");
    }

    for (const key of Object.keys(plugin.definition.emits ?? {}))
    {
        checkNamespaced(name, key, "event", say) && claim("events", key, "DUPLICATE_EVENT", "Event");
    }

    for (const key of Object.keys(plugin.definition.hooks ?? {}))
    {
        checkNamespaced(name, key, "hook", say) && claim("hooks", key, "DUPLICATE_HOOK", "Hook");
    }

    for (const key of Object.keys(plugin.definition.commands ?? {}))
    {
        checkNamespaced(name, key, "command", say) && claim("commands", key, "DUPLICATE_COMMAND", "Command");
    }

    // A table name is global in SQLite, so two plugins claiming one would
    // share storage while both believing it private.
    for (const key of Object.keys(plugin.definition.tables ?? {}))
    {
        claim("tables", key, "DUPLICATE_TABLE", "Table");
    }

    for (const route of plugin.definition.routes ?? [])
    {
        path(name, route.method, route.path, owned, say);

        if (route.describe.trim() === "")
        {
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" has no description. A route nobody described is one nobody can review.`);
        }

        // An output schema that cannot strip is not a whitelist, and the
        // route's whole promise rests on it.
        if (!filters(route.output))
        {
            say("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" has an output schema that cannot filter what leaves. Use z.object naming every field that may be sent: it strips the rest. z.any, z.unknown, z.record, z.looseObject, a catchall and a transform all forward whatever the handler returned.`);
        }

        checkLimit(name, route, say);
        checkHeaders(name, route, say);
    }

    const scope = plugin.definition.scope;

    if (scope !== undefined)
    {
        const owns = plugin.definition.tables ?? {};

        if (scope.claim.trim() === "")
        {
            say("UNDECLARED_SCOPE", name, "A scope names the claim it reads. An empty one reads nothing.");
        }

        for (const table of Object.keys(scope.tables))
        {
            if (!(table in owns))
            {
                say("UNDECLARED_SCOPE", name, `Scope names "${table}", which is not one of this plugin's tables. A plugin scopes only what it owns.`);
            }
        }

        if (Object.keys(scope.tables).length === 0)
        {
            say("UNDECLARED_SCOPE", name, "A scope names no table, so nothing is scoped. Name the tables that carry the claim, or remove it.");
        }
    }

    for (const host of plugin.definition.outbound ?? [])
    {
        const wrong = whyUnreachable(host);

        if (wrong !== undefined)
        {
            say("UNDECLARED_HOST", name, wrong);
        }
    }

    if (!/^\d+\.\d+\.\d+/.test(plugin.definition.version))
    {
        say("INVALID_NAME", name, `Version "${plugin.definition.version}" is not a version. Use major.minor.patch.`);
    }

    if (plugin.definition.describe.trim() === "")
    {
        say("INVALID_NAME", name, "A plugin describes itself in one sentence. An empty description tells the next reader nothing.");
    }
}

/**
 * A header carrying a credential, which no route may ask to read.
 *
 * A handler holding one would put it in a log the moment anyone logged its
 * input, and the framework cannot know which handler is careful.
 */
const SECRET: ReadonlySet<string> = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);

/** The headers a route asks to read. */
function checkHeaders(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], say: Report): void
{
    for (const header of route.reads ?? [])
    {
        if (header !== header.toLowerCase())
        {
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}". Header names are matched lowercase.`);

            continue;
        }

        if (SECRET.has(header))
        {
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}", which carries a credential. Whoever identifies the caller reads it; a handler holding it would log it.`);
        }
    }
}

/** A route's own budget, when it declares one. */
/**
 * Which schemes a plugin may declare, and what each one means.
 *
 * Not a list of protocols the kit speaks: the kit speaks https and nothing
 * else. It is a list of what a plugin may say it talks to, so a connection
 * opened by a plugin's own client is still declared, still visible in the
 * contract, and still refused when it was never named.
 */
const SCHEMES: ReadonlySet<string> = new Set([
    "https",  // an api, and what ctx.fetch dials
    "wss",    // a socket, encrypted
    "redis",
    "rediss",
    "postgres",
    "postgresql",
    "mysql",
    "mongodb",
    "mongodb+srv",
    "amqp",
    "amqps",
    "grpc",
    "grpcs",
]);

/** Schemes that carry credentials in the clear, and reach beyond a network. */
const PLAIN: ReadonlySet<string> = new Set(["http", "ws", "ftp"]);

/**
 * Why a declared host cannot be reached, or undefined when it can.
 *
 * A plugin declares what it talks to before it talks to it, whatever protocol
 * that is: a cache, a queue and a vector store are all things a reader of the
 * contract should see, and refusing to let them be written does not stop them
 * being used, only being declared.
 */
function whyUnreachable(host: string): string | undefined
{
    const at = host.indexOf("://");

    if (at === -1)
    {
        return `Outbound host "${host}" names no scheme. Write it as an origin, such as "https://api.stripe.com" or "redis://cache.internal:6379".`;
    }

    const scheme = host.slice(0, at).toLowerCase();
    const rest = host.slice(at + 3);

    if (PLAIN.has(scheme))
    {
        return `Outbound host "${host}" is not encrypted. Use "${scheme}s://" instead: what travels over ${scheme} travels in the clear, credentials included.`;
    }

    if (!SCHEMES.has(scheme))
    {
        return `Outbound host "${host}" uses a scheme this kit does not know. Declared hosts are one of: ${[...SCHEMES].join(", ")}.`;
    }

    if (!/^[a-z0-9._-]+(:\d+)?$/i.test(rest))
    {
        return `Outbound host "${host}" is not an origin. Declare the host it reaches, such as "${scheme}://cache.internal:6379", and no path.`;
    }

    return undefined;
}

function checkLimit(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], say: Report): void
{
    const limit = route.limit;

    if (limit === undefined)
    {
        return;
    }

    if (!Number.isInteger(limit.requests) || limit.requests < 1)
    {
        say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares ${limit.requests} requests per window. A budget under one refuses everything, including the caller who set it.`);
    }

    if (!Number.isInteger(limit.seconds) || limit.seconds < 1)
    {
        say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares a window of ${limit.seconds} seconds. A window without length is one that never resets.`);
    }
}

/** One route path: how it must be written, and who already took it. */
function path(name: string, method: string, given: string, owned: Claimed, say: Report): void
{
    if (!given.startsWith("/"))
    {
        say("INVALID_ROUTE", name, `Route path "${given}" must start with "/".`);

        return;
    }

    if (/\s/.test(given))
    {
        say("INVALID_ROUTE", name, `Route path "${given}" contains whitespace.`);

        return;
    }

    if (given.includes("//") || (given.length > 1 && given.endsWith("/")))
    {
        say("INVALID_ROUTE", name, `Route path "${given}" has an empty segment. Two paths differing only by a slash are one route to a caller and two to a router.`);

        return;
    }

    for (const segment of given.split("/").slice(1))
    {
        // A parameter is a name in code, so it reads like one: `:documentId`
        // beside `documentId` everywhere else. A literal segment is part of
        // the url, which is case-sensitive and shared with people, so it
        // stays lowercase.
        const named = segment.startsWith(":")
            ? /^:[a-zA-Z][a-zA-Z0-9]*$/.test(segment)
            : /^[a-z0-9][a-z0-9-]*$/.test(segment);

        if (!named)
        {
            say("INVALID_ROUTE", name, segment.startsWith(":")
                ? `Route path "${given}" names a parameter "${segment}", which is not letters and digits starting with a letter.`
                : `Route path "${given}" has a segment "${segment}" outside lowercase letters, digits and hyphens.`);

            return;
        }
    }

    // A parameter is a wildcard, so two routes differing only in what they
    // named it answer the same request, and which one wins is registration
    // order.
    const shape = `${method} ${given.replace(/:[a-zA-Z0-9]+/g, ":*")}`;
    const first = owned.routes.get(shape);

    if (first !== undefined)
    {
        say("DUPLICATE_ROUTE", name, `Route ${method} "${given}" is already declared by "${first}". Which one answers would depend on order.`);

        return;
    }

    owned.routes.set(shape, name);
}

/** Checks one namespaced name, reporting rather than throwing. */
function checkNamespaced(owner: string, key: string, kind: string, say: Report): boolean
{
    try
    {
        names.namespaced(key, kind, owner);

        return true;
    }
    catch (cause)
    {
        say("INVALID_NAME", owner, cause instanceof Error ? cause.message : String(cause));

        return false;
    }
}

/** What a plugin refers to: it must exist, and be reachable. */
function checkReferences(name: string, plugin: Plugin, by: ReadonlyMap<string, Plugin>, owned: Claimed, say: Report): void
{
    const declared = new Set(plugin.definition.dependsOn ?? []);

    /** Declared somewhere. What a listener needs, and all it needs. */
    const mustExist = (kind: keyof Claimed, key: string, code: KernelFault["code"], label: string): void =>
    {
        if (owned[kind].get(key) === undefined)
        {
            // The third answer is the one a listener usually needs and the
            // one nobody guesses: hearing does not depend, but the plugin
            // that declares the event still has to be here to declare it.
            const owner = key.split(".")[0] ?? "";
            const hint = owner !== "" && owner !== name && !by.has(owner)
                ? ` "${owner}" would declare it and was not given to createKernel: pass it too, which a test of a listener has to do.`
                : "";

            say(code, name, `${label} "${key}" is not declared by any plugin. Declare it, or correct the name.${hint}`);
        }
    };

    for (const need of declared)
    {
        if (!by.has(need))
        {
            say("UNKNOWN_DEPENDENCY", name, `"${name}" depends on "${need}", which no plugin provides. Pass it to createKernel, or remove it from dependsOn.`);
        }
    }

    const reach = (kind: keyof Claimed, key: string, code: KernelFault["code"], label: string): void =>
    {
        const from = owned[kind].get(key);

        if (from === undefined)
        {
            say(code, name, `${label} "${key}" is not declared by any plugin. Declare it, or correct the name.`);

            return;
        }

        if (from !== name && !declared.has(from))
        {
            say("UNDECLARED_DEPENDENCY", name, `${label} "${key}" belongs to "${from}", which "${name}" does not depend on. Add "${from}" to dependsOn.`);
        }
    };

    // Hearing is not depending. An event is announced to nobody in
    // particular: the emitter does not know who listens and never waits, so a
    // listener adds no edge to the graph. Requiring one made the commonest
    // real shape impossible, because two capabilities that each react to the
    // other are a cycle only on paper.
    for (const key of Object.keys(plugin.definition.listens ?? {}))
    {
        mustExist("events", key, "UNDECLARED_EVENT", "Event");
    }

    // A hook is the same: the owner runs it and reads what comes back, so the
    // participant is the one being called, not the one calling.
    for (const key of Object.keys(plugin.definition.participates ?? {}))
    {
        mustExist("hooks", key, "UNDECLARED_HOOK", "Hook");
    }

    for (const route of plugin.definition.routes ?? [])
    {
        for (const permission of route.requires ?? [])
        {
            reach("permissions", permission, "UNDECLARED_PERMISSION", "Permission");
        }

        // A route open to the world that also demands a permission is two
        // intentions in one declaration, and only one of them can hold.
        if (route.public === true && (route.requires ?? []).length > 0)
        {
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" is public and also requires ${(route.requires ?? []).map((one) => `"${one}"`).join(", ")}. It is one or the other.`);
        }
    }

    for (const one of Object.values(plugin.definition.commands ?? {}))
    {
        for (const permission of one.requires ?? [])
        {
            reach("permissions", permission, "UNDECLARED_PERMISSION", "Permission");
        }
    }
}

/** Config is parsed by the plugin's own schema, where it enters. */
function checkConfig(name: string, plugin: Plugin, config: Readonly<Record<string, unknown>>, say: Report): void
{
    const schema = plugin.definition.config;

    if (schema === undefined)
    {
        return;
    }

    const answered = schema.safeParse(config[name] ?? {});

    if (!answered.success)
    {
        const first = answered.error.issues[0];
        const at = first === undefined || first.path.length === 0 ? "" : ` at "${first.path.join(".")}"`;

        say("INVALID_CONFIG", name, `Config for "${name}" is invalid${at}: ${first?.message ?? "it does not match the schema"}.`);
    }
}

/** A cycle in dependsOn, named from where it was entered back to itself. */
function checkCycles(by: ReadonlyMap<string, Plugin>, say: Report): void
{
    const state = new Map<string, "open" | "done">();
    const walking: string[] = [];
    const reported = new Set<string>();

    function walk(name: string): void
    {
        if (state.get(name) === "done")
        {
            return;
        }

        if (state.get(name) === "open")
        {
            const at = walking.indexOf(name);
            const loop = [...walking.slice(at === -1 ? 0 : at), name];
            const key = [...loop].sort().join(",");

            if (!reported.has(key))
            {
                reported.add(key);
                say("DEPENDENCY_CYCLE", name, `Plugins depend on each other in a loop: ${loop.join(" -> ")}. One of them has to stop.`);
            }

            return;
        }

        state.set(name, "open");
        walking.push(name);

        for (const need of [...(by.get(name)?.definition.dependsOn ?? [])].sort())
        {
            if (by.has(need))
            {
                walk(need);
            }
        }

        walking.pop();
        state.set(name, "done");
    }

    for (const name of [...by.keys()].sort())
    {
        walk(name);
    }
}
