import { createHash } from "node:crypto";

import type { Context, DocumentPolicy, Route } from "./contract";
import { Reply } from "./refusal";
import { filterHeaders } from "./replyHeaders";
import type { KernelRequest, KernelResponse } from "./request";

type RequestLog = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;

/** The directives a page's policy may name, and how each is written. Anything not said is 'none'. */
const DIRECTIVES: Readonly<Record<keyof DocumentPolicy, string>> = {
    defaultSrc: "default-src",
    scriptSrc: "script-src",
    styleSrc: "style-src",
    fontSrc: "font-src",
    connectSrc: "connect-src",
    imgSrc: "img-src",
    frameAncestors: "frame-ancestors",
    baseUri: "base-uri",
    formAction: "form-action",
};

/** The headers a document may choose for itself. */
const DOCUMENT_HEADERS: ReadonlySet<string> = new Set(["cache-control", "vary", "content-language"]);

/**
 * A 304 updates the headers a browser stored for the page, so it repeats every header that
 * decides how the page is treated, not only the tag: a framable page revalidated with the
 * kit's defaults would become unframable.
 */
const KEPT_ON_NOT_MODIFIED = ["cache-control", "vary", "content-language", "content-security-policy", "x-frame-options", "x-content-type-options", "content-disposition"];

/** A page's policy as one header, written from named source lists so no value can smuggle in a directive of its own; or why it cannot be. */
export function policyFor(policy: DocumentPolicy = {}, framable = false): { header: string; refused?: undefined } | { refused: string }
{
    const unknown = Object.keys(policy).filter((key) => !Object.hasOwn(DIRECTIVES, key));

    if (unknown.length > 0)
    {
        return { refused: `names ${unknown.map((key) => `"${key}"`).join(", ")}, which is no directive the kit writes` };
    }

    const given: DocumentPolicy = { defaultSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], ...policy };

    for (const [key, sources] of Object.entries(given) as [keyof DocumentPolicy, unknown][])
    {
        if (!Array.isArray(sources) || sources.length === 0)
        {
            return { refused: `gives ${key} no sources; write ["'none'"] to refuse everything` };
        }

        for (const source of sources as unknown[])
        {
            if (typeof source !== "string" || source === "" || /[;,\s]/u.test(source))
            {
                return { refused: `gives ${key} a source holding a separator or whitespace` };
            }

            if (source === "'unsafe-eval'" || (source === "'unsafe-inline'" && key === "scriptSrc"))
            {
                return { refused: `gives ${key} ${source}, which the kit never sends` };
            }
        }
    }

    const framing = given.frameAncestors ?? [];

    if (!framable && !(framing.length === 1 && framing[0] === "'none'"))
    {
        return { refused: "lets other sites frame it; declare document: { framable: true } on the route" };
    }

    return { header: (Object.entries(given) as [keyof DocumentPolicy, readonly string[]][]).map(([key, sources]) => `${DIRECTIVES[key]} ${sources.join(" ")}`).join("; ") };
}

/** A route's answer as an HTML page under its own policy. */
export function documentAnswer(returned: unknown, route: Route<Context> & { document: NonNullable<Route<Context>["document"]> }, plugin: string, log: RequestLog, incoming: KernelRequest): KernelResponse
{
    const reply = returned instanceof Reply ? returned : typeof returned === "string" ? Reply.document(returned) : undefined;

    const failed = (why: string): KernelResponse =>
    {
        log("error", plugin, `${route.method} ${route.path} ${why}`);

        return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
    };

    if (reply === undefined || typeof reply.body !== "string")
    {
        return failed("declares document, and its handle answered neither Reply.document nor a string");
    }

    const framable = route.document.framable === true;
    const policy = policyFor(reply.document?.policy ?? route.document.policy, framable);

    if (policy.refused !== undefined)
    {
        return failed(`answered a policy that ${policy.refused}`);
    }

    const headers = {
        "cache-control": "no-cache",
        ...filterHeaders(reply.headers, plugin, route, log, (name) => DOCUMENT_HEADERS.has(name)),
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": policy.header,
        "x-content-type-options": "nosniff",
        ...(!framable && { "x-frame-options": "DENY" }),
    };

    return { ...tagged({ status: reply.status, body: reply.body, headers }, route, incoming, reply.document?.etag), document: true };
}

/** A tag in quotes, as the header carries it. */
export function quotedTag(tag: string): string
{
    return /^(W\/)?"[^"]*"$/u.test(tag) ? tag : `"${tag.replaceAll("\"", "")}"`;
}

/** Whether an If-None-Match names this tag: weakly compared, a list, or `*`. */
function matchesTag(header: string | undefined, etag: string): boolean
{
    if (header === undefined)
    {
        return false;
    }

    const opaque = (tag: string): string => tag.trim().replace(/^W\//u, "");

    return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

/**
 * Every GET answering 200 carries a weak ETag: the one the reply chose, or a hash of what it
 * sends. A matching If-None-Match answers 304 with the tag and the headers deciding how the
 * answer is kept and treated.
 */
export function tagged(answer: KernelResponse, route: Route<Context>, incoming: KernelRequest, chosen?: string): KernelResponse
{
    if (route.method !== "GET" || answer.status !== 200)
    {
        return answer;
    }

    const named = chosen ?? answer.headers?.["etag"];
    const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body) ?? "";
    const etag = named === undefined ? `W/"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"` : quotedTag(named);
    const headers: Record<string, string> = { ...answer.headers, etag };

    if (matchesTag(incoming.ifNoneMatch, etag))
    {
        const kept = Object.fromEntries(KEPT_ON_NOT_MODIFIED.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name] as string]));

        return { status: 304, body: null, headers: { etag, ...kept }, ...(answer.document === true && { document: true }) };
    }

    return { ...answer, headers };
}
