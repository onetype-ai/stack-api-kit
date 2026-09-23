import type { Plugin } from "./contract";
import type { KernelFault } from "./faults";
import * as names from "./names";
import { tableName } from "./tableName";
import { isFilterable, numberRanges } from "./output";
import { policyFor } from "./document";
import { FILE_TYPES } from "./file";
import { isKitHeader } from "./replyHeaders";

/** One thing wrong, and everything needed to fix it. */
export type ContractProblem = {
    code: KernelFault["code"];
    plugin: string;
    message: string;
};

type ProblemReport = (code: KernelFault["code"], plugin: string, message: string) => void;

type TableOwners = {
    routes: Map<string, string>;
    events: Map<string, string>;
    channels: Map<string, string>;
    hooks: Map<string, string>;
    commands: Map<string, string>;
    permissions: Map<string, string>;
    tables: Map<string, string>;
};

/** Checks every contract, and reports everything wrong rather than the first. */
export function validate(plugins: readonly Plugin[], config: Readonly<Record<string, unknown>>, grantedBy?: string): ContractProblem[]
{
    const problems: ContractProblem[] = [];
    const report: ProblemReport = (code, plugin, message) =>
    {
        problems.push({ code, plugin, message });
    };

    const by = new Map<string, Plugin>();

    for (const plugin of plugins)
    {
        if (by.has(plugin.name))
        {
            report("DUPLICATE_PLUGIN", plugin.name, `Two plugins are named "${plugin.name}". A name is what everything else refers to, so it must be unique.`);

            continue;
        }

        by.set(plugin.name, plugin);
    }

    const owned: TableOwners = {
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
        checkOwn(name, plugin, owned, report);
    }

    for (const [name, plugin] of by)
    {
        checkReferences(name, plugin, by, owned, report);
        checkConfig(name, plugin, config, report);
    }

    checkCycles(by, report);
    checkGranting(by, owned, report, grantedBy);

    return problems;
}

/** Who says who a caller is, and what being one means. */
function checkGranting(by: ReadonlyMap<string, Plugin>, owned: TableOwners, report: ProblemReport, grantedBy?: string): void
{
    for (const key of ["identifies", "grants"] as const)
    {
        const owners = [...by].filter(([, plugin]) => plugin.definition[key] !== undefined).map(([name]) => name);

        if (owners.length > 1)
        {
            report("DUPLICATE_GRANTS", owners[1] as string, `"${owners.join('", "')}" all declare ${key}. One plugin answers this for the whole api.`);
        }
    }

    // grants answers what the caller holds, so any plugin declaring it decides
    // the whole authorization model. The application names the one that may.
    if (grantedBy !== undefined)
    {
        for (const [name, plugin] of by)
        {
            if (plugin.definition.grants !== undefined && name !== grantedBy)
            {
                report("UNNOMINATED_GRANTS", name, `"${name}" declares grants, and this application named "${grantedBy}" as the one that may. A plugin granting itself permissions decides what every guard allows.`);
            }
        }
    }

    const granter = [...by.values()].find((plugin) => plugin.definition.grants !== undefined);

    if (granter === undefined)
    {
        return;
    }

    const supported = granter.definition.grantsSupported === undefined
        ? new Set(owned.permissions.keys())
        : new Set(granter.definition.grantsSupported);

    // An empty grantsSupported reads as the strictest declaration and is the loosest
    // outcome: nothing is supported, so every guarded route is permanently 403
    // with nothing said. Declaring none is a decision worth stating.
    if (granter.definition.grantsSupported !== undefined && supported.size === 0)
    {
        report("UNGRANTABLE_PERMISSION", granter.name, `"${granter.name}" declares grantsSupported as an empty list, so it grants nothing and every route naming a permission is unreachable. Name the permissions it may grant, or leave grantsSupported out.`);

        return;
    }

    if (supported.size === 0)
    {
        return;
    }

    for (const [name, plugin] of by)
    {
        for (const route of plugin.definition.routes ?? [])
        {
            for (const permission of route.requires ?? [])
            {
                if (!supported.has(permission))
                {
                    report("UNGRANTABLE_PERMISSION", name, `Route ${route.method} "${route.path}" requires "${permission}", which "${granter.name}" never grants. Add it to grantsSupported, or nobody can reach this route.`);
                }
            }
        }
    }
}

/** What a plugin declares, and whether anyone claimed it first. */
function checkOwn(name: string, plugin: Plugin, owned: TableOwners, report: ProblemReport): void
{
    const claim = (kind: keyof TableOwners, key: string, code: KernelFault["code"], label: string): void =>
    {
        const owner = owned[kind].get(key);

        if (owner !== undefined)
        {
            report(code, name, `${label} "${key}" is already declared by "${owner}". Two plugins cannot own one name.`);

            return;
        }

        owned[kind].set(key, name);
    };

    for (const key of Object.keys(plugin.definition.permissions ?? {}))
    {
        checkNamespaced(name, key, "permission", report) && claim("permissions", key, "DUPLICATE_PERMISSION", "Permission");
    }

    for (const key of Object.keys(plugin.definition.emits ?? {}))
    {
        checkNamespaced(name, key, "event", report) && claim("events", key, "DUPLICATE_EVENT", "Event");
    }

    for (const key of Object.keys(plugin.definition.hooks ?? {}))
    {
        checkNamespaced(name, key, "hook", report) && claim("hooks", key, "DUPLICATE_HOOK", "Hook");
    }

    for (const [key, channel] of Object.entries(plugin.definition.channels ?? {}))
    {
        checkNamespaced(name, key, "channel", report) && claim("channels", key, "DUPLICATE_CHANNEL", "Channel");

        if (channel.reach === "scope" && plugin.definition.scope === undefined)
        {
            report("UNDECLARED_SCOPE", name, `Channel "${key}" reaches a scope, and "${name}" declares none. Declare one, or reach further.`);
        }
    }

    for (const key of Object.keys(plugin.definition.commands ?? {}))
    {
        checkNamespaced(name, key, "command", report) && claim("commands", key, "DUPLICATE_COMMAND", "Command");
    }

    for (const [key, table] of Object.entries(plugin.definition.tables ?? {}))
    {
        claim("tables", tableName(table) ?? key, "DUPLICATE_TABLE", "Table");
    }

    const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

    for (const route of plugin.definition.routes ?? [])
    {
        checkPath(name, route.method, route.path, owned, report);

        // dispatch matches "METHOD path" exactly, so a lowercase or invented
        // method answered nothing and said nothing about why
        if (!METHODS.has(route.method as string))
        {
            report("INVALID_ROUTE", name, `Route "${String(route.method)} ${route.path}" names a method nothing will match. Use one of ${[...METHODS].join(", ")}.`);
        }

        // each of these answered 500 on every request instead of refusing here,
        // and the 500 named none of them
        if (typeof route.handle !== "function")
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares no handle, so every request to it answers 500. Add handle: (input, ctx) => ....`);
        }

        if (typeof (route.input as { safeParse?: unknown } | undefined)?.safeParse !== "function")
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares no input schema. Every route parses what arrives: use z.object({}) for one that takes nothing.`);
        }

        if (typeof route.describe !== "string" || route.describe.trim() === "")
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" has no description. A route nobody described is one nobody can review.`);
        }

        checkAnswers(name, route, report);

        checkRanges(name, route, report);
        // Neither public nor guarded answers every signed-in caller, whatever
        // they hold. `public` is written out so a world-readable route is a
        // decision; an empty `requires` must be written out for the same
        // reason, or an omission is indistinguishable from a decision.
        if (route.public !== true && route.requires === undefined)
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" names no permission and is not public, so every signed-in caller may reach it. Declare requires: [...], mark it public: true, or write requires: [] to say anyone signed in may.`);
        }

        checkLimit(name, route, report);
        checkHeaders(name, route, report);
    }

    const scope = plugin.definition.scope;

    if (scope !== undefined)
    {
        const owns = plugin.definition.tables ?? {};

        if (scope.claim.trim() === "")
        {
            report("UNDECLARED_SCOPE", name, "A scope names the claim it reads. An empty one reads nothing.");
        }

        for (const [table, column] of Object.entries(scope.tables))
        {
            if (!(table in owns))
            {
                report("UNDECLARED_SCOPE", name, `Scope names "${table}", which is not one of this plugin's tables. A plugin scopes only what it owns.`);

                continue;
            }

            // The column is knowable here, and naming one the table lacks used
            // to boot clean and then fail on whichever request read it first.
            // Only a real table is checked: a test may stand one in as {}, and
            // refusing that would fail every kernel built without a database.
            const columns = owns[table] as Readonly<Record<string, unknown>> | undefined;
            const real = columns !== undefined && typeof columns === "object" && Object.keys(columns).length > 0;

            if (real && !(column in (columns as Readonly<Record<string, unknown>>)))
            {
                report("UNDECLARED_SCOPE", name, `Scope narrows "${table}" by "${column}", and the table declares no such column. Name the column that carries the claim.`);
            }
        }

        if (Object.keys(scope.tables).length === 0)
        {
            report("UNDECLARED_SCOPE", name, "A scope names no table, so nothing is scoped. Name the tables that carry the claim, or remove it.");
        }
    }

    for (const host of plugin.definition.allowedHosts === "anywhere" ? [] : plugin.definition.allowedHosts ?? [])
    {
        const unreachable = whyUnreachable(host);

        if (unreachable !== undefined)
        {
            report("UNDECLARED_HOST", name, unreachable);
        }
    }

    if (!/^\d+\.\d+\.\d+/.test(plugin.definition.version))
    {
        report("INVALID_NAME", name, `Version "${plugin.definition.version}" is not a version. Use major.minor.patch.`);
    }

    if (plugin.definition.describe.trim() === "")
    {
        report("INVALID_NAME", name, "A plugin describes itself in one sentence. An empty description tells the next reader nothing.");
    }
}

/** A header carrying a credential, which no route may ask to read. */
export const SECRET: ReadonlySet<string> = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie", "x-session-key"]);

/** A header naming a signature, by shape rather than by partner. */
const SIGNATURE = /(^|-)(signature|sig|hmac)(-|$)/;

/** The headers a route asks to read. */
function checkHeaders(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], report: ProblemReport): void
{
    for (const header of route.reads ?? [])
    {
        if (header !== header.toLowerCase())
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}". Header names are matched lowercase.`);

            continue;
        }

        if (SECRET.has(header))
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}", which carries a credential. Whoever identifies the caller reads it; a handler holding it would log it.`);

            continue;
        }

        if (SIGNATURE.test(header) && route.keepsRaw !== true)
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" reads "${header}" and does not declare keepsRaw. A signature is checked against the bytes that arrived, and this route never sees them: the body is parsed before the handler runs. Add keepsRaw: true and check ctx.sent, or drop "${header}" from reads and stop claiming the check.`);
        }
    }

    for (const header of route.sends ?? [])
    {
        if (typeof header !== "string" || !/^[a-z0-9-]+$/u.test(header) || isKitHeader(header))
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" sends "${String(header)}". A route sends lowercase header names the kit does not answer for; this one is either not a header name or governs how a browser treats the response.`);
        }
    }
}

/** Which schemes a plugin may declare, and what each one means. */
const SCHEMES: ReadonlySet<string> = new Set([
    "https",
    "wss",
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

/** Why a declared host cannot be reached, or undefined when it can. */
function whyUnreachable(host: string): string | undefined
{
    const schemeEnd = host.indexOf("://");

    if (schemeEnd === -1)
    {
        return `Declared host "${host}" names no scheme. Write it as an origin, such as "https://api.stripe.com" or "redis://cache.internal:6379".`;
    }

    const scheme = host.slice(0, schemeEnd).toLowerCase();
    const rest = host.slice(schemeEnd + 3);

    if (PLAIN.has(scheme))
    {
        return `Declared host "${host}" is not encrypted. Use "${scheme}s://" instead: what travels over ${scheme} travels in the clear, credentials included.`;
    }

    if (!SCHEMES.has(scheme))
    {
        return `Declared host "${host}" uses a scheme this kit does not know. Declared hosts are one of: ${[...SCHEMES].join(", ")}.`;
    }

    if (!/^[a-z0-9._-]+(:\d+)?$/i.test(rest))
    {
        return `Declared host "${host}" is not an origin. Declare the host it reaches, such as "${scheme}://cache.internal:6379", and no path.`;
    }

    return undefined;
}

function checkLimit(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], report: ProblemReport): void
{
    const limit = route.limit;

    if (limit === undefined)
    {
        return;
    }

    if (!Number.isInteger(limit.requests) || limit.requests < 1)
    {
        report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares ${limit.requests} requests per window. A budget under one refuses everything, including the caller who set it.`);
    }

    if (!Number.isInteger(limit.seconds) || limit.seconds < 1)
    {
        report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares a window of ${limit.seconds} seconds. A window without length is one that never resets.`);
    }
}

/** What a route answers with: one answer, a stream of events, or either per request, each through a schema that filters. */
function checkAnswers(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], report: ProblemReport): void
{
    const answers = (["output", "streams", "document", "file"] as const).filter((key) => route[key] !== undefined);
    const answersEither = answers.length === 2 && answers.includes("output") && answers.includes("streams");

    if (answers.length === 0)
    {
        report("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" declares no output. Name what an answer may carry with output, what each event may carry with streams, a document, or a file.`);
    }

    if (answers.length > 1 && !answersEither)
    {
        report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares ${answers.join(" and ")}. A route answers once, streams, serves a document or a file: keep the one it does, or declare output and streams alone to answer either per request.`);
    }

    if (route.file !== undefined)
    {
        const types: readonly unknown[] = Array.isArray(route.file.types) ? route.file.types : [];
        const refused = types.filter((type) => typeof type !== "string" || !FILE_TYPES.has(type));

        if (types.length === 0 || refused.length > 0)
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares file types ${refused.length > 0 ? refused.map((type) => `"${String(type)}"`).join(", ") : "none"}. A file is sent as one of ${[...FILE_TYPES].join(", ")}.`);
        }
    }

    if (route.document !== undefined)
    {
        const policy = policyFor(route.document.policy, route.document.framable === true);

        if (policy.refused !== undefined)
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" declares a document policy that ${policy.refused}.`);
        }
    }

    if (route.streamSeconds !== undefined && !(typeof route.streamSeconds === "number" && route.streamSeconds > 0 && route.streamSeconds <= 86_400))
    {
        report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" gives streamSeconds ${String(route.streamSeconds)}. A stream lives more than 0 and at most 86400 seconds.`);
    }

    if (route.streams !== undefined && !isFilterable(route.streams))
    {
        report("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" has a streams schema that cannot filter what leaves. Use z.object naming every field an event may carry: it strips the rest.`);
    }

    if (route.output !== undefined && !isFilterable(route.output))
    {
        report("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" has an output schema that cannot filter what leaves. Use z.object naming every field that may be sent: it strips the rest. z.any, z.unknown, z.record, z.looseObject, a catchall and a transform all forward whatever the handler returned.`);
    }
}

/** A number the route bounds on the way in and lets out bare. */
function checkRanges(name: string, route: NonNullable<Plugin["definition"]["routes"]>[number], report: ProblemReport): void
{
    if (route.input === undefined || route.output === undefined)
    {
        return;
    }

    const leaving = numberRanges(route.output);

    for (const [field, bounded] of numberRanges(route.input))
    {
        if (bounded && leaving.get(field) === false)
        {
            report("INVALID_OUTPUT", name, `Route ${route.method} "${route.path}" bounds "${field}" on the way in and answers it bare. Give the output the same range, or the caller has to guess what the number means.`);
        }
    }
}

/** One route path: how it must be written, and who already took it. */
function checkPath(name: string, method: string, given: string, owned: TableOwners, report: ProblemReport): void
{
    if (!given.startsWith("/"))
    {
        report("INVALID_ROUTE", name, `Route path "${given}" must start with "/".`);

        return;
    }

    if (/\s/.test(given))
    {
        report("INVALID_ROUTE", name, `Route path "${given}" contains whitespace.`);

        return;
    }

    if (given.includes("//") || (given.length > 1 && given.endsWith("/")))
    {
        report("INVALID_ROUTE", name, `Route path "${given}" has an empty segment. Two paths differing only by a slash are one route to a caller and two to a router.`);

        return;
    }

    for (const segment of given.split("/").slice(1))
    {
        const segmentName = segment.startsWith(":")
            ? /^:[a-zA-Z][a-zA-Z0-9]*$/.test(segment)
            : /^[a-z0-9][a-z0-9-]*$/.test(segment);

        if (!segmentName)
        {
            report("INVALID_ROUTE", name, segment.startsWith(":")
                ? `Route path "${given}" names a parameter "${segment}", which is not letters and digits starting with a letter.`
                : `Route path "${given}" has a segment "${segment}" outside lowercase letters, digits and hyphens.`);

            return;
        }
    }

    const shape = `${method} ${given.replace(/:[a-zA-Z0-9]+/g, ":*")}`;
    const owner = owned.routes.get(shape);

    if (owner !== undefined)
    {
        report("DUPLICATE_ROUTE", name, `Route ${method} "${given}" is already declared by "${owner}". Which one answers would depend on order.`);

        return;
    }

    owned.routes.set(shape, name);
}

/** Checks one namespaced name, reporting rather than throwing. */
function checkNamespaced(owner: string, key: string, kind: string, report: ProblemReport): boolean
{
    try
    {
        names.namespacedName(key, kind, owner);

        return true;
    }
    catch (cause)
    {
        report("INVALID_NAME", owner, cause instanceof Error ? cause.message : String(cause));

        return false;
    }
}

/** What a plugin refers to: it must exist, and be reachable. */
function checkReferences(name: string, plugin: Plugin, by: ReadonlyMap<string, Plugin>, owned: TableOwners, report: ProblemReport): void
{
    const declared = new Set(plugin.definition.dependsOn ?? []);

    /** Declared somewhere. What a listener needs, and all it needs. */
    const mustExist = (kind: keyof TableOwners, key: string, code: KernelFault["code"], label: string): void =>
    {
        if (owned[kind].get(key) === undefined)
        {
            const owner = key.split(".")[0] ?? "";
            const hint = owner !== "" && owner !== name && !by.has(owner)
                ? ` "${owner}" would declare it and was not given to createKernel: pass it too, which a test of a listener has to do.`
                : "";

            report(code, name, `${label} "${key}" is not declared by any plugin. Declare it, or correct the name.${hint}`);
        }
    };

    const absent = [...declared].filter((need) => !by.has(need));

    if (absent.length > 0)
    {
        const single = absent.length === 1;
        const missing = absent.map((need) => `"${need}"`).join(", ");
        const each = single ? "That one declares its own dependsOn" : "Those declare their own dependsOn";

        report("UNKNOWN_DEPENDENCY", name, `"${name}" depends on ${missing}, which no plugin provides. Pass ${single ? "it" : "them"} to createKernel, or remove ${single ? "it" : "them"} from dependsOn. ${each}, which this run cannot read from here: pass what they name too, or every boot names one more link.`);
    }

    const reach = (kind: keyof TableOwners, key: string, code: KernelFault["code"], label: string): void =>
    {
        const from = owned[kind].get(key);

        if (from === undefined)
        {
            report(code, name, `${label} "${key}" is not declared by any plugin. Declare it, or correct the name.`);

            return;
        }

        if (from !== name && !declared.has(from))
        {
            report("UNDECLARED_DEPENDENCY", name, `${label} "${key}" belongs to "${from}", which "${name}" does not depend on. Add "${from}" to dependsOn.`);
        }
    };

    for (const key of Object.keys(plugin.definition.listens ?? {}))
    {
        mustExist("events", key, "UNDECLARED_EVENT", "Event");

        if (owned.events.get(key) === name)
        {
            report("SELF_HEARD_EVENT", name, `"${name}" listens to its own "${key}", and a plugin never hears what it emitted. Call the service directly.`);
        }
    }

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

        if (route.public === true && (route.requires ?? []).length > 0)
        {
            report("INVALID_ROUTE", name, `Route ${route.method} "${route.path}" is public and also requires ${(route.requires ?? []).map((permission) => `"${permission}"`).join(", ")}. It is one or the other.`);
        }
    }

    for (const command of Object.values(plugin.definition.commands ?? {}))
    {
        for (const permission of command.requires ?? [])
        {
            reach("permissions", permission, "UNDECLARED_PERMISSION", "Permission");
        }
    }
}

/** Config is parsed by the plugin's own schema, where it enters. */
function checkConfig(name: string, plugin: Plugin, config: Readonly<Record<string, unknown>>, report: ProblemReport): void
{
    const schema = plugin.definition.config;

    if (schema === undefined)
    {
        return;
    }

    const parsed = schema.safeParse(config[name] ?? {});

    if (!parsed.success)
    {
        const issue = parsed.error.issues[0];
        const location = issue === undefined || issue.path.length === 0 ? "" : ` at "${issue.path.join(".")}"`;

        report("INVALID_CONFIG", name, `Config for "${name}" is invalid${location}: ${issue?.message ?? "it does not match the schema"}.`);
    }
}

/** A cycle in dependsOn, named from where it was entered back to itself. */
function checkCycles(by: ReadonlyMap<string, Plugin>, report: ProblemReport): void
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
            const seenAt = trail.indexOf(name);
            const loop = [...trail.slice(seenAt === -1 ? 0 : seenAt), name];
            const key = [...loop].sort().join(",");

            if (!reported.has(key))
            {
                reported.add(key);
                report("DEPENDENCY_CYCLE", name, `Plugins depend on each other in a loop: ${loop.join(" -> ")}. One of them has to stop.`);
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
