import { answer, Reply, Refusal } from "./answer";
import type { Identity, Context, Method, Route } from "./contract";
import { KernelFault } from "./faults";
import { createPermissions } from "./permissions";

/** What decides whether one identity has any budget left on one route. */
export type Budget = {
    spend: (key: string, window: { requests: number; seconds: number }) => { allowed: boolean; resetsIn: number };

    /**
     * Gives one spend back, for a route counting only what it guards against.
     *
     * Optional, because a project brings its own budget and one written
     * before this still counts every call. A route asking for it and getting
     * nothing back is a route that counts everything, which is where it
     * started.
     */
    refund?: (key: string) => void;
};

/** One request, as it reaches the kernel. */
export type Incoming = {
    method: Method;
    path: string;
    input: unknown;
    identity?: Identity | undefined;

    /** The request's headers, lowercase. A route sees only what it declared. */
    headers?: Readonly<Record<string, string>> | undefined;

    /**
     * The body's bytes as they arrived, for a route that declared `keepsRaw`.
     *
     * Carried beside `input` rather than instead of it: the schema still
     * runs, and a signature still has the string it was computed over.
     */
    sent?: Uint8Array | undefined;

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
export type RouteOwner = {
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
 * Authentication comes before parsing so an anonymous identity cannot reach a
 * schema, and filtering comes last so a handler cannot leak by returning too
 * much.
 */
export async function respond(
    mounted: RouteOwner,
    incoming: Incoming,
    context: (plugin: string, identity?: Identity, headers?: Readonly<Record<string, string>>, sent?: Uint8Array) => Context,
    log: Log,
    budget?: Budget,
): Promise<Outgoing>
{
    const { plugin, route } = mounted;
    const identity = incoming.identity;
    const permissions = createPermissions(() => identity);

    /* identify may be written in JavaScript, where the type does not hold: an
       id of "" is nobody, and every such one would share one rate-limit bucket. */
    const identityId = identity !== undefined && identity.id.trim() !== "" ? identity.id : undefined;

    // Spent up front, because a refused request must not reach the handler.
    // A route that counts only failures gives it back once the answer says it
    // succeeded, which is the first moment anything knows.
    let spent: string | undefined;

    try
    {
        if (route.public !== true && identityId === undefined)
        {
            throw new KernelFault("UNAUTHENTICATED", `${route.method} ${route.path} needs a caller.`, { plugin });
        }

        // After identity, so one caller's flood cannot spend another's
        // budget, and before the handler, so a refused request costs nothing.
        if (route.limit !== undefined && budget !== undefined)
        {
            spent = `${identityId ?? incoming.from ?? "anonymous"}:${route.method} ${route.path}`;

            const verdict = budget.spend(spent, route.limit);

            if (!verdict.allowed)
            {
                spent = undefined;

                return {
                    status: 429,
                    body: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
                    headers: { "retry-after": String(verdict.resetsIn) },
                };
            }
        }

        const lacking = (route.requires ?? []).filter((permission) => !permissions.has(permission));

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

        // Handed on only where the route asked: bytes nobody declared are
        // bytes a log can carry, the same reason `reads` names its headers.
        const sent = route.keepsRaw === true ? incoming.sent : undefined;

        const returned = await route.handle(parsed.data, context(plugin, identity, headersFor(route, incoming.headers), sent));

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

        const status = carried?.status ?? (route.method === "POST" ? 201 : 200);

        // Read off the status rather than off "the handler returned": a
        // handler may answer Reply(409) without throwing, and giving that one
        // its spend back would hand an attacker a free attempt for every
        // refusal a route chose to return rather than raise.
        if (spent !== undefined && route.limit?.countSuccess === false && status < 400)
        {
            budget?.refund?.(spent);
        }

        if (carried !== undefined)
        {
            return { status, body: filtered.data, headers: filterHeaders(carried.headers, plugin, route, log) };
        }

        return { status, body: filtered.data };
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
            log("error", plugin, `${route.method} ${route.path} threw`, logRecord(cause));
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
function logRecord(cause: unknown): Readonly<Record<string, unknown>>
{
    if (cause instanceof Error)
    {
        return {
            error: cause.message,
            kind: cause.name,
            ...(cause.stack !== undefined && { stack: cause.stack }),
            ...(cause.cause !== undefined && { cause: logRecord(cause.cause) }),
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
const OURS: ReadonlySet<string> = new Set([
    "set-cookie",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "access-control-allow-origin",
    "access-control-allow-credentials",
]);

/** The headers a handler asked for, minus the ones it may not set. */
function filterHeaders(
    asked: Readonly<Record<string, string>>,
    plugin: string,
    route: Route<Context>,
    log: Log,
): Readonly<Record<string, string>>
{
    const outgoing: Record<string, string> = {};

    for (const [name, value] of Object.entries(asked))
    {
        const lower = name.toLowerCase();

        if (OURS.has(lower))
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

        outgoing[lower] = value;
    }

    return outgoing;
}

/**
 * The headers a route named, and nothing else.
 *
 * A handler that could read any header could read the cookie carrying the
 * session, and anything logging its input would then be logging a credential.
 */
function headersFor(route: Route<Context>, sent: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>>
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
