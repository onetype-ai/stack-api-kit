import { answer, Reply, Refusal } from "./answer";
import type { Caller, Context, Method, Route } from "./contract";
import { KernelFault } from "./faults";
import { permissions } from "./permissions";

/** What decides whether one caller has any budget left on one route. */
export type Budget = {
    take: (key: string, window: { requests: number; seconds: number }) => { allowed: boolean; resetsIn: number };
};

/** One request, as it reaches the kernel. */
export type Incoming = {
    method: Method;
    path: string;
    input: unknown;
    caller?: Caller | undefined;

    /** The request's headers, lowercase. A route sees only what it declared. */
    headers?: Readonly<Record<string, string>> | undefined;

    /**
     * Where it came from, when nobody is signed in: an address, a key, or
     * whatever the project counts anonymous callers by. Only a rate limit
     * reads it.
     */
    from?: string | undefined;
};

/** What the kernel answers: a status, and a body already safe to send. */
export type Outgoing = {
    status: number;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
};

/** A route the kernel holds, and who declared it. */
export type Mounted = {
    plugin: string;
    route: Route<Context>;
};

type Log = (
    level: "debug" | "info" | "warn" | "error",
    plugin: string,
    line: string,
    about?: Readonly<Record<string, unknown>>,
) => void;

/** Nothing found. Said the same way whoever asked, so probing learns nothing. */
export const unknownRoute: Outgoing = {
    status: 404,
    body: { code: "NOT_FOUND", message: "No such route." },
};

/** The kernel has stopped. A retry elsewhere is the only useful answer. */
export const notServing: Outgoing = {
    status: 503,
    body: { code: "NOT_SERVING", message: "The service is shutting down." },
};

/**
 * Answers one request.
 *
 * The order is the whole security story, and it is deliberate:
 *
 *   1. signed in, unless the route says it is public
 *   2. permitted, against what the route declared
 *   3. parsed, so a handler only ever sees input that passed its schema
 *   4. run
 *   5. filtered, so only what the output schema names leaves
 *
 * Authentication comes before parsing so an anonymous caller cannot reach a
 * schema, and filtering comes last so a handler cannot leak by returning too
 * much.
 */
export async function respond(
    mounted: Mounted,
    incoming: Incoming,
    context: (plugin: string, caller?: Caller, headers?: Readonly<Record<string, string>>) => Context,
    log: Log,
    budget?: Budget,
): Promise<Outgoing>
{
    const { plugin, route } = mounted;
    const caller = incoming.caller;
    const may = permissions(() => caller);

    // An id of "" is nobody, not somebody. A project writing `id: row?.userId
    // ?? ""` would otherwise authenticate a caller with no identity, and
    // every such caller would share one rate-limit bucket besides.
    const who = caller?.id !== undefined && caller.id.trim() !== "" ? caller.id : undefined;

    try
    {
        if (route.public !== true && who === undefined)
        {
            throw new KernelFault("UNAUTHENTICATED", `${route.method} ${route.path} needs a caller.`, { plugin });
        }

        // After identity, so one caller's flood cannot spend another's
        // budget, and before the handler, so a refused request costs nothing.
        if (route.limit !== undefined && budget !== undefined)
        {
            const verdict = budget.take(`${who ?? incoming.from ?? "anonymous"}:${route.method} ${route.path}`, route.limit);

            if (!verdict.allowed)
            {
                return {
                    status: 429,
                    body: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
                    headers: { "retry-after": String(verdict.resetsIn) },
                };
            }
        }

        const lacking = (route.requires ?? []).filter((permission) => !may.has(permission));

        if (lacking.length > 0)
        {
            throw new KernelFault(
                "PERMISSION_DENIED",
                `${route.method} ${route.path} needs ${lacking.map((permission) => `"${permission}"`).join(", ")}.`,
                { plugin, detail: { lacking } },
            );
        }

        const parsed = route.input.safeParse(incoming.input);

        if (!parsed.success)
        {
            throw new Refusal(400, "INVALID_INPUT", "The request is not valid.", fields(parsed.error));
        }

        const returned = await route.handle(parsed.data, context(plugin, caller, declared(route, incoming.headers)));

        // A handler may say what status and headers its answer carries. The
        // body still passes the schema either way: what a route sends is
        // never a decision the handler alone makes.
        const carried = returned instanceof Reply ? returned : undefined;

        // A whitelist, not a check: what the schema does not name does not
        // leave, so a column added to a table tomorrow cannot appear in a
        // response by itself.
        const filtered = route.output.safeParse(carried === undefined ? returned : carried.body);

        if (!filtered.success)
        {
            log("error", plugin, `${route.method} ${route.path} returned what its output schema refuses`, {
                issues: filtered.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
            });

            return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
        }

        if (carried !== undefined)
        {
            return { status: carried.status, body: filtered.data, headers: sendable(carried.headers, plugin, route, log) };
        }

        return { status: route.method === "POST" ? 201 : 200, body: filtered.data };
    }
    catch (cause)
    {
        const refusal = answer(cause);

        // A 5xx is ours and nobody saw it; a 4xx was already explained to
        // whoever caused it.
        //
        // Read off the error rather than passed whole: an Error serialises to
        // "{}", so a log holding one says a request failed and nothing about
        // why, which is the moment the log existed for.
        if (refusal.status >= 500)
        {
            log("error", plugin, `${route.method} ${route.path} threw`, told(cause));
        }

        return {
            status: refusal.status,
            body: {
                code: refusal.code,
                message: refusal.message,
                ...(refusal.fields !== undefined && { fields: refusal.fields }),
            },
        };
    }
}

/** What a thrown thing says, in a shape that survives being written down. */
function told(cause: unknown): Readonly<Record<string, unknown>>
{
    if (cause instanceof Error)
    {
        return {
            error: cause.message,
            kind: cause.name,
            ...(cause.stack !== undefined && { stack: cause.stack }),
            ...(cause.cause !== undefined && { cause: told(cause.cause) }),
        };
    }

    return { error: String(cause) };
}

/**
 * A header a handler may never set.
 *
 * `set-cookie` decides who the caller is on their next request, which is the
 * session plugin's business and nobody else's. The rest are the kit's own
 * answer about itself, and a route overriding them turns one endpoint into
 * the hole in a policy that holds everywhere else.
 */
const KEPT: ReadonlySet<string> = new Set([
    "set-cookie",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "access-control-allow-origin",
    "access-control-allow-credentials",
]);

/** The headers a handler asked for, minus the ones it may not set. */
function sendable(
    asked: Readonly<Record<string, string>>,
    plugin: string,
    route: Route<Context>,
    log: Log,
): Readonly<Record<string, string>>
{
    const sending: Record<string, string> = {};

    for (const [name, value] of Object.entries(asked))
    {
        const lower = name.toLowerCase();

        if (KEPT.has(lower))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}", which the kit answers for`);

            continue;
        }

        // A newline splits one header into two, and the second is whatever
        // the value's author wanted to say.
        if (/[\r\n]/.test(value))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}" to a value carrying a newline`);

            continue;
        }

        sending[lower] = value;
    }

    return sending;
}

/**
 * The headers a route named, and nothing else.
 *
 * A handler that could read any header could read the cookie carrying the
 * session, and anything logging its input would then be logging a credential.
 */
function declared(route: Route<Context>, sent: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>>
{
    const sending: Record<string, string> = {};

    for (const name of route.reads ?? [])
    {
        const value = sent[name];

        if (value !== undefined)
        {
            sending[name] = value;
        }
    }

    return sending;
}

/**
 * Which fields failed, and why.
 *
 * Built only from an input schema the plugin wrote, so what it names is what
 * the caller already sent us.
 */
function fields(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): Record<string, string>
{
    const named: Record<string, string> = {};

    for (const issue of error.issues)
    {
        const at = issue.path.map((segment) => String(segment)).join(".");

        if (at !== "" && named[at] === undefined)
        {
            named[at] = issue.message;
        }
    }

    return named;
}
