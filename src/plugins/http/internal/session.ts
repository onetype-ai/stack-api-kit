/** How a route's answer becomes a session cookie. */
export type SessionOptions = {
    /** The cookie's name. Prefix it `__Host-` in production: without that a sibling host can set a second cookie of this name on a narrower path, and a request carrying two is refused rather than guessed at. */
    name: string;

    /** Whether to mark it `Secure`. */
    secure: boolean;

    sameSite?: "Strict" | "Lax" | "None";

    /** Where the cookie applies. Defaults to the whole origin. */
    path?: string;

    domain?: string;
};

/** Before this, a number is a lifetime rather than a moment: 2001-09-09. */
const LEAST_MOMENT = 1_000_000_000_000;

/** What a route says about the session, and what never reaches the caller. */
export const SessionHeaders = {
    key: "x-session-key",

    /** When the session ends, in epoch milliseconds: `Date.now() + lifetime`. */
    expires: "x-session-expires",

    end: "x-session-end",
} as const;

/** One `set-cookie` line, or the one that clears it when seconds is zero. */
export function cookieFor(key: string, seconds: number, options: SessionOptions): string
{
    // A "__Host-" name is the only way to stop a sibling host setting a second
    // cookie of the same name on a narrower path, which is how a session is
    // shadowed. The browser enforces it, but drops the cookie silently when the
    // rules are broken, so every sign-in would fail with nothing to explain it.
    if (options.name.startsWith("__Host-") && (options.secure !== true || options.domain !== undefined || (options.path ?? "/") !== "/"))
    {
        throw new TypeError(`A "__Host-" cookie must be Secure, name no Domain, and use Path=/; "${options.name}" does not, so the browser would discard it.`);
    }

    const parts = [
        `${options.name}=${encodeURIComponent(key)}`,
        `Path=${options.path ?? "/"}`,
        "HttpOnly",
        `SameSite=${options.sameSite ?? "Lax"}`,
        `Max-Age=${String(Math.max(0, Math.floor(seconds)))}`,
    ];

    if (options.domain !== undefined)
    {
        parts.push(`Domain=${options.domain}`);
    }

    if (options.secure || options.sameSite === "None")
    {
        parts.push("Secure");
    }

    return parts.join("; ");
}

/** Reads one cookie out of a request's header, by name. */
export function cookieIn(header: string | undefined, name: string): string | undefined
{
    let value: string | undefined;

    for (const part of (header ?? "").split(";"))
    {
        const equals = part.indexOf("=");

        if (equals > 0 && part.slice(0, equals).trim() === name)
        {
            // Two cookies of one name means a second was set on a narrower
            // path, which the browser sends first. Answering either picks a
            // session the second writer chose, so neither is read. A "__Host-"
            // name stops the browser storing a second at all, which is the only
            // fix that keeps a legitimate session; SessionOptions.name says so.
            if (value !== undefined)
            {
                return undefined;
            }

            const raw = part.slice(equals + 1).trim();

            try
            {
                value = decodeURIComponent(raw);
            }
            catch
            {
                // a malformed escape is not a session; cookieIn is public, so
                // this must not throw into whatever called it
                return undefined;
            }
        }
    }

    return value;
}

export type SessionResult = {
    cookie: string | undefined;
    headers: Readonly<Record<string, string>>;
};

/** What a route asked for, turned into a cookie and taken back out. */
export function sessionCookie(
    answered: Readonly<Record<string, string>>,
    options: SessionOptions,
    now: number,
): SessionResult
{
    const key = answered[SessionHeaders.key];
    const ending = answered[SessionHeaders.end];

    if (key === undefined && ending === undefined)
    {
        return { cookie: undefined, headers: answered };
    }

    const headers = { ...answered };

    delete headers[SessionHeaders.key];
    delete headers[SessionHeaders.expires];
    delete headers[SessionHeaders.end];

    if (key === undefined)
    {
        return { cookie: cookieFor("", 0, options), headers };
    }

    const expires = Number(answered[SessionHeaders.expires] ?? 0);

    if (Number.isFinite(expires) && expires > 0 && expires < LEAST_MOMENT)
    {
        throw new TypeError(`${SessionHeaders.expires} is a moment in epoch milliseconds, and ${String(expires)} is a lifetime. Send Date.now() + lifetime.`);
    }

    // An unreadable expiry closes the session rather than opening an endless
    // one, which is deliberate; Max-Age=0 alone looked like a successful
    // sign-in, so the cookie carries nothing a browser would keep.
    const seconds = Number.isFinite(expires) ? (expires - now) / 1000 : 0;

    return { cookie: cookieFor(key, seconds, options), headers };
}

/** The same request, carrying the key its cookie holds and no key a caller sent. */
export function withSessionKey(request: Request, options: SessionOptions | undefined): Request
{
    if (options === undefined)
    {
        return request;
    }

    // The cookie is the only source. Honouring a header the caller sent let
    // anyone name their own session: a forged header beat the real cookie, and
    // a request with no cookie at all was identified by whatever it claimed.
    const key = cookieIn(request.headers.get("cookie") ?? undefined, options.name);

    if (!request.headers.has(SessionHeaders.key) && key === undefined)
    {
        return request;
    }

    const headers = new Headers(request.headers);

    if (key === undefined)
    {
        headers.delete(SessionHeaders.key);
    }
    else
    {
        headers.set(SessionHeaders.key, key);
    }

    return new Request(request, { headers });
}
