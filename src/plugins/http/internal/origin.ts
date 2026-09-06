/**
 * Which cross-origin callers are answered, and what they are allowed.
 *
 * A whitelist rather than a reflection: echoing back whatever Origin arrived,
 * which is what `*` with credentials amounts to, is every site the caller has
 * open being allowed to spend their session.
 */
export type CorsPolicy = {
    origins: readonly string[];
    methods: readonly string[];
    headers: readonly string[];
    maxAge: number;
};

/**
 * The CORS headers for one request.
 *
 * `vary` is set whether or not the origin is allowed: the answer differs by
 * Origin either way, and a cache keyed without it would hand one site's
 * allowance to another.
 */
export function cors(policy: CorsPolicy, origin: string | undefined): Readonly<Record<string, string>>
{
    if (origin === undefined || !policy.origins.includes(origin))
    {
        return { vary: "Origin" };
    }

    return {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": policy.methods.join(", "),
        "access-control-allow-headers": policy.headers.join(", "),
        "access-control-max-age": String(policy.maxAge),
        vary: "Origin",
    };
}
