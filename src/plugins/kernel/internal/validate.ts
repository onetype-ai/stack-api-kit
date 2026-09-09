import type { Plugin } from "./contract";
import type { KernelFault } from "./faults";
import * as names from "./names";
import { tableName } from "./tablename";
import { canFilter, rangedNumbers } from "./output";

/** One thing wrong, and everything needed to fix it. */
export type ContractProblem = {
    code: KernelFault["code"];
    plugin: string;
    message: string;
};

type Report = (code: KernelFault["code"], plugin: string, message: string) => void;

type Ownership = {
    routes: Map<string, string>;
    events: Map<string, string>;
    channels: Map<string, string>;
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

    const owned: Ownership = {
        routes: new Map(),
        events: new Map(),
        channels: new Map(),
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
    checkGranting(by, owned, say);

    return wrong;
}

/**
 * Who says who a caller is, and what being one means.
 *
 * Two plugins answering either question is two answers to one, and nothing
 * decides between them. And a route requiring a permission nothing grants is
 * a route nobody can reach: it starts, it answers 403 to everyone, and it is
 * found by trying rather than by starting.
 */
function checkGranting(by: ReadonlyMap<string, Plugin>, owned: Ownership, say: Report): void
{
    for (const key of ["identifies", "grants"] as const)
    {
        const owners = [...by].filter(([, plugin]) => plugin.definition[key] !== undefined).map(([name]) => name);

        if (owners.length > 1)
        {
            say("DUPLICATE_GRANTS", owners[1] as string, `"${owners.join('", "')}" all declare ${key}. One plugin answers this for the whole api.`);
        }
    }

    const granting = [...by.values()].find((plugin) => plugin.definition.grants !== undefined);

    if (granting === undefined)
    {
        return;
    }

    // `grants` runs per request, so startup can only check the ceiling. A
    // plugin that named one is held to it; one that named none may grant
    // anything declared, so a plugin arriving later guards its own route
    // without editing whoever holds identity.
    const may = granting.definition.mayGrant === undefined
        ? new Set(owned.permissions.keys())
        : new Set(granting.definition.mayGrant);

    if (may.size === 0)
    {
        return;
    }

    for (const [name, plugin] of by)
    {
        for (const route of plugin.definition.routes ?? [])
        {
            for (const permission of route.requires ?? [])
            {
                if (!may.has(permission))
                {
                    say("UNGRANTABLE_PERMISSION", name, `Route ${route.method} "${route.path}" requires "${permission}", which "${granting.name}" never grants. Add it to mayGrant, or nobody can reach this route.`);
                }
            }
        }
    }
}

/** What a plugin declares, and whether anyone claimed it first. */
function checkOwn(name: string, plugin: Plugin, owned: Ownership, say: Report): void
{
    const claim = (kind: keyof Ownership, key: string, code: KernelFault["code"], label: string): void =>
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

    for (const [key, channel] of Object.entries(plugin.definition.channels ?? {}))
    {
        checkNamespaced(name, key, "channel", say) && claim("channels", key, "DUPLICATE_CHANNEL", "Channel");

        // A channel reaching a scope in a plugin that declares none reaches
        // nobody, and does it quietly.
        if (channel.reach === "scope" && plugin.definition.scope === undefined)
        {
            say("UNDECLARED_SCOPE", name, `Channel "${key}" reaches a scope, and "${name}" declares none. Declare one, or reach further.`);
        }
    }

    for (const key of Object.keys(plugin.definition.commands ?? {}))
    {
        checkNamespaced(name, key, "command", say) && claim("commands", key, "DUPLICATE_COMMAND", "Command");
    }

    // The name in the database is what is global, not the key it was
    // declared under: two plugins sharing a key own different tables, and two
    // sharing a name share storage while both believe it private. A store the
    // project built answers no name, so the key stands in for it.
    for (const [key, table] of Object.entries(plugin.definition.tables ?? {}))
    {
        claim("tables", tableName(table) ?? key, "DUPLICATE_TABLE", "Table");
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
        if (!canFilter(route.output))
        {
            say("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" has an output schema that cannot filter what leaves. Use z.object naming every field that may be sent: it strips the rest. z.any, z.unknown, z.record, z.looseObject, a catchall and a transform all forward whatever the handler returned.`);
        }

        checkRanges(name, route, say);
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

    for (const host of plugin.definition.outbound === "anywhere" ? [] : plugin.definition.outbound ?? [])
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
export const SECRET: ReadonlySet<string> = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);

/**
 * A header naming a signature, by shape rather than by partner.
 *
 * A list of names would be a list of whose webhooks the kit has heard of:
 * `stripe-signature`, `x-hub-signature-256`, `svix-signature`,
 * `x-shopify-hmac-sha256` and the next one nobody has written yet. The word
 * is the thing they have in common, and it is a word nobody puts in a header
 * name by accident.
 */
const SIGNATURE = /(^|-)(signature|sig|hmac)(-|$)/;

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

            continue;
        }

        // Refused rather than warned, because this one cannot be made to work
        // by being careful: a signature is over the bytes that arrived, and
        // parsing reorders keys and drops whitespace. Re-serialising the
        // parsed value gives a different string, and no canonical form
        // recovers the original.
        if (SIGNATURE.test(header) && route.keepsRaw !== true)
        {
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}" and does not declare keepsRaw. A signature is checked against the bytes that arrived, and this route never sees them: the body is parsed before the handler runs. Add keepsRaw: true and check ctx.sent, or drop "${header}" from reads and stop claiming the check.`);
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

/**
 * A number the route bounds on the way in and lets out bare.
 *
 * The range is the field's meaning, not decoration: a caller told 0..1 is a
 * share, and the same field answered as a plain number leaves the consumer to
 * guess. It guesses the shape it already knows, so a scale that outgrew one
 * reads as a share of a hundred and nothing anywhere is wrong.
 *
 * Only the same route is compared. Two plugins naming one field mean two
 * different things often enough that the name alone proves nothing.
 */
function checkRanges(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], say: Report): void
{
    if (route.input === undefined || route.output === undefined)
    {
        return;
    }

    const leaving = rangedNumbers(route.output);

    for (const [field, bounded] of rangedNumbers(route.input))
    {
        if (bounded && leaving.get(field) === false)
        {
            say("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" bounds "${field}" on the way in and answers it bare. Give the output the same range, or the caller has to guess what the number means.`);
        }
    }
}

/** One route path: how it must be written, and who already took it. */
function path(name: string, method: string, given: string, owned: Ownership, say: Report): void
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
function checkReferences(name: string, plugin: Plugin, by: ReadonlyMap<string, Plugin>, owned: Ownership, say: Report): void
{
    const declared = new Set(plugin.definition.dependsOn ?? []);

    /** Declared somewhere. What a listener needs, and all it needs. */
    const mustExist = (kind: keyof Ownership, key: string, code: KernelFault["code"], label: string): void =>
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

    const absent = [...declared].filter((need) => !by.has(need));

    if (absent.length > 0)
    {
        // Named together, and said to be a chain: what is added next declares
        // its own dependsOn, which this run cannot read because those plugins
        // are not here. A caller adding one at a time pays a boot per link.
        const one = absent.length === 1;
        const missing = absent.map((need) => `"${need}"`).join(", ");
        const each = one ? "That one declares its own dependsOn" : "Those declare their own dependsOn";

        say("UNKNOWN_DEPENDENCY", name, `"${name}" depends on ${missing}, which no plugin provides. Pass ${one ? "it" : "them"} to createKernel, or remove ${one ? "it" : "them"} from dependsOn. ${each}, which this run cannot read from here: pass what they name too, or every boot names one more link.`);
    }

    const reach = (kind: keyof Ownership, key: string, code: KernelFault["code"], label: string): void =>
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

        // Delivery skips the emitter, so this listener would never run: five
        // places would say it had, and the row it writes would not be there.
        if (owned.events.get(key) === name)
        {
            say("UNHEARD_EVENT", name, `"${name}" listens to its own "${key}", and a plugin never hears what it emitted. Call the service directly.`);
        }
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
            say("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" is public and also requires ${(route.requires ?? []).map((permission) => `"${permission}"`).join(", ")}. It is one or the other.`);
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

    const parsed = schema.safeParse(config[name] ?? {});

    if (!parsed.success)
    {
        const first = parsed.error.issues[0];
        const at = first === undefined || first.path.length === 0 ? "" : ` at "${first.path.join(".")}"`;

        say("INVALID_CONFIG", name, `Config for "${name}" is invalid${at}: ${first?.message ?? "it does not match the schema"}.`);
    }
}

/** A cycle in dependsOn, named from where it was entered back to itself. */
function checkCycles(by: ReadonlyMap<string, Plugin>, say: Report): void
{
    const state = new Map<string, "open" | "done">();
    const trail: string[] = [];
    const reported = new Set<string>();

    function walk(name: string): void
    {
        if (state.get(name) === "done")
        {
            return;
        }

        if (state.get(name) === "open")
        {
            const at = trail.indexOf(name);
            const loop = [...trail.slice(at === -1 ? 0 : at), name];
            const key = [...loop].sort().join(",");

            if (!reported.has(key))
            {
                reported.add(key);
                say("DEPENDENCY_CYCLE", name, `Plugins depend on each other in a loop: ${loop.join(" -> ")}. One of them has to stop.`);
            }

            return;
        }

        state.set(name, "open");
        trail.push(name);

        for (const need of [...(by.get(name)?.definition.dependsOn ?? [])].sort())
        {
            if (by.has(need))
            {
                walk(need);
            }
        }

        trail.pop();
        state.set(name, "done");
    }

    for (const name of [...by.keys()].sort())
    {
        walk(name);
    }
}
