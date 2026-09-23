import { KernelFault } from "./faults";

import type { HttpRequest } from "./contract";

/** What a call does with a redirect. */
export type RedirectMode = "refuse" | "manual" | "follow";

/** One redirect a call was answered with. */
export type Hop = {
    status: number;
    location: string;
};

/** 300 names no one place and 304 answers a conditional request, so neither is a hop. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const MODES: readonly RedirectMode[] = ["refuse", "manual", "follow"];

/** The most hops any call may take. */
export const MOST_REDIRECTS = 10;

/** How many hops "follow" takes when a call names none. */
export const DEFAULT_REDIRECTS = 5;

/** How long a followed chain may take when a call names no `timeoutMs`. */
export const FOLLOW_BUDGET_MS = 30_000;

/** The mode a call asked for, refused when it cannot be honoured. */
export function redirectsOf(plugin: string, call: HttpRequest, anywhere: boolean): RedirectMode
{
    const redirects = call.redirects ?? "refuse";

    if (!MODES.includes(redirects))
    {
        throw new KernelFault("INVALID_CALL", `"${plugin}" passed redirects "${String(redirects)}". Pass one of ${MODES.join(", ")}, or leave it out to refuse redirects.`, { plugin });
    }

    // a declared host is trusted, where its redirect may lead is not: only "anywhere" checks every hop
    if (redirects !== "refuse" && !anywhere)
    {
        throw new KernelFault("INVALID_CALL", `"${plugin}" asked to take redirects from a host it declares, where a redirect could lead anywhere. Take redirects only with allowedHosts "anywhere", where every hop is checked.`, { plugin });
    }

    const most = call.mostRedirects;

    if (most !== undefined && (redirects !== "follow" || !Number.isInteger(most) || most < 1 || most > MOST_REDIRECTS))
    {
        throw new KernelFault("INVALID_CALL", `"${plugin}" passed mostRedirects ${String(most)}. Pass a whole number from 1 to ${String(MOST_REDIRECTS)}, and only with redirects "follow".`, { plugin });
    }

    return redirects;
}

/** The hop a streamed answer is, when it is one. */
export function hopOf(answer: unknown): Hop | undefined
{
    if (typeof answer !== "object" || answer === null || !("status" in answer) || typeof answer.status !== "number" || !REDIRECT_STATUSES.has(answer.status))
    {
        return undefined;
    }

    return "location" in answer && typeof answer.location === "string" ? { status: answer.status, location: answer.location } : undefined;
}

/** The origin of a url, or undefined when it is not one. */
function originOf(url: string): string | undefined
{
    try
    {
        return new URL(url).origin;
    }
    catch
    {
        return undefined;
    }
}

/**
 * The call a hop leads to, as the fetch standard makes it: 303, and 301 or 302 after a POST,
 * become a GET without a body; every other method keeps its method and body. A hop
 * to another origin carries none of the caller's headers, since they were meant for the first.
 */
export function nextHop(call: HttpRequest, hop: Hop): HttpRequest
{
    const { body, headers, ...rest } = call;
    const becomesGet = hop.status === 303 || ((hop.status === 301 || hop.status === 302) && call.method === "POST");
    const next: HttpRequest = { ...rest, url: hop.location, ...(becomesGet && { method: "GET" }) };

    if (!becomesGet && body !== undefined)
    {
        next.body = body;
    }

    if (headers !== undefined && originOf(hop.location) === originOf(call.url))
    {
        next.headers = headers;
    }

    return next;
}
