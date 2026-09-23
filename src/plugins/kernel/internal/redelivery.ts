import type { Context, Route } from "./contract";

type RequestLog = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;

/** What a reply may say about itself without declaring it. Everything that governs how a browser treats the response is the kit's. */
const REPLY_HEADERS: ReadonlySet<string> = new Set([
    "location",
    "retry-after",
    "content-disposition",
    "vary",
    "etag",
    "cache-control",
    "x-session-key",
    "x-session-expires",
    "x-session-end",
]);

/** Headers the kit answers for: policy, framing, transport, sniffing, cookies and content type. */
const KIT_HEADERS: ReadonlySet<string> = new Set([
    "set-cookie",
    "content-type",
    "content-length",
    "transfer-encoding",
    "connection",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "strict-transport-security",
    "permissions-policy",
    "x-xss-protection",
    "x-permitted-cross-domain-policies",
    "x-dns-prefetch-control",
]);

/** Whether a header is one only the kit may set, CORS and the cross-origin family included. */
export function isKitHeader(name: string): boolean
{
    return KIT_HEADERS.has(name) || name.startsWith("access-control-") || name.startsWith("cross-origin-") || name.startsWith("sec-");
}

/** Directives that let a shared cache keep the body: fine for a public route, one caller's answer handed to the next for any other. */
export const SHARED_CACHE = /(^|,)\s*(public|s-maxage|proxy-revalidate)\b/iu;

/** What a reply was refused before the allow-list, and still is by default until 9.0. */
const REFUSED_BEFORE_ALLOW_LIST: ReadonlySet<string> = new Set([
    "set-cookie",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "access-control-allow-origin",
    "access-control-allow-credentials",
]);

/** How a kernel holds replies to the header allow-list, and which headers it already warned about. */
export type ReplyHeaderPolicy = {
    strict: boolean;
    warned: Set<string>;
};

/**
 * The headers a route's reply sends. Held to the allow-list when the kernel is strict; otherwise, until 9.0
 * makes it the default, everything the kit refused before passes, and each header the allow-list will drop
 * is named once, with how to keep it.
 */
export function replyHeaders(asked: Readonly<Record<string, string>>, plugin: string, route: Route<Context>, log: RequestLog, policy: ReplyHeaderPolicy): Readonly<Record<string, string>>
{
    if (policy.strict)
    {
        return filterHeaders(asked, plugin, route, log);
    }

    const sent = filterHeaders(asked, plugin, route, log, (name) => !REFUSED_BEFORE_ALLOW_LIST.has(name));

    for (const name of Object.keys(sent))
    {
        const key = `${route.method} ${route.path} ${name}`;

        if (!REPLY_HEADERS.has(name) && !(route.sends ?? []).includes(name) && !policy.warned.has(key))
        {
            policy.warned.add(key);
            log("warn", plugin, `${route.method} ${route.path} sets "${name}", which 9.0 drops: declare it in the route's sends, or pass strictReplyHeaders: true to hold every route to the allow-list now`);
        }
    }

    return sent;
}

/** The headers a handler asked for, minus the ones it may not set. */
export function filterHeaders(
    asked: Readonly<Record<string, string>>,
    plugin: string,
    route: Route<Context>,
    log: RequestLog,
    allowed: (name: string) => boolean = (name) => REPLY_HEADERS.has(name) || (route.sends ?? []).includes(name),
): Readonly<Record<string, string>>
{
    const outgoing: Record<string, string> = {};

    for (const [name, value] of Object.entries(asked))
    {
        const lower = name.toLowerCase();

        if (!allowed(lower))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}", which it may not: declare it in sends, unless the kit answers for it`);

            continue;
        }

        if (/[\r\n]/.test(value))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}" to a value carrying a newline`);

            continue;
        }

        if (lower === "cache-control" && route.public !== true && SHARED_CACHE.test(value))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to let a shared cache keep an answer only its caller may see`);

            continue;
        }

        outgoing[lower] = value;
    }

    return outgoing;
}
