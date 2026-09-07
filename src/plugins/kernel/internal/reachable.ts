/**
 * Whether an address is one the outside world may be reached at.
 *
 * A plugin declaring `outbound: "anywhere"` has hosts that are rows rather
 * than constants, so the whitelist cannot hold. What replaces it is not a
 * weaker list but a different question: not "did you name this host" but
 * "is this an address on the public internet at all".
 *
 * Every form below was measured against a real request. A loopback address
 * has more spellings than anyone expects, and one of them is how a crawl of
 * a customer's site becomes a read of the machine it runs on.
 */

/** Ports the web is served on. Anything else is a service, not a site. */
const PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Names that resolve to this machine whatever the resolver says. */
const NAMED: ReadonlySet<string> = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
]);

/** Why this url may not be dialled, or undefined when it may. */
export function whyUnfetchable(raw: string): string | undefined
{
    let url: URL;

    try
    {
        url = new URL(raw.trim());
    }
    catch
    {
        return `"${raw}" is not an address.`;
    }

    if (url.protocol !== "https:")
    {
        return "ctx.fetch speaks https and nothing else.";
    }

    if (!PORTS.has(url.port === "" ? 443 : Number(url.port)))
    {
        return `Port ${url.port} is not one the web is served on.`;
    }

    // A credential in the url is one the caller reads off a log line, and
    // one the host it was meant for never asked for.
    if (url.username !== "" || url.password !== "")
    {
        return "An address carrying a credential is refused.";
    }

    return unroutable(url.hostname) ? "That address is not on the public internet." : undefined;
}

/** Whether a host, written any of the ways it can be, is not public. */
export function unroutable(rawHost: string): boolean
{
    const host = rawHost.toLowerCase().replace(/\.$/u, "");

    if (host === "" || NAMED.has(host))
    {
        return true;
    }

    if (host.startsWith("[") || host.includes(":"))
    {
        return sixUnroutable(host.replace(/^\[|\]$/gu, ""));
    }

    const four = asFour(host);

    // A name, not an address. What it resolves to is checked separately,
    // because a name is the one part of an address its owner can change
    // after it has been read.
    return four === undefined ? false : fourUnroutable(four);
}

/** Whether a resolved address is not public. Anything unreadable is not. */
export function addressUnroutable(address: string): boolean
{
    if (address.includes(":"))
    {
        return sixUnroutable(address);
    }

    const four = asFour(address);

    return four === undefined ? true : fourUnroutable(four);
}

function fourUnroutable(parts: readonly number[]): boolean
{
    const [first = 0, second = 0] = parts;

    if (first === 0 || first === 10 || first === 127)
    {
        return true;
    }

    // 169.254.169.254 is where a cloud instance reads its own credentials.
    if (first === 169 && second === 254)
    {
        return true;
    }

    if (first === 172 && second >= 16 && second <= 31)
    {
        return true;
    }

    if (first === 192 && (second === 0 || second === 168))
    {
        return true;
    }

    if (first === 100 && second >= 64 && second <= 127)
    {
        return true;
    }

    return first >= 224;
}

function sixUnroutable(host: string): boolean
{
    const address = host.toLowerCase();

    if (address === "::" || address === "::1")
    {
        return true;
    }

    // ::ffff:127.0.0.1 is a loopback address the URL standard rewrites into
    // hexadecimal groups, so a check reading decimals alone never fires.
    const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/u.exec(address);

    if (mapped?.[1] !== undefined)
    {
        return mappedUnroutable(mapped[1]);
    }

    const head = address.split(":")[0] ?? "";

    if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb"))
    {
        return true;
    }

    return head.startsWith("fc") || head.startsWith("fd");
}

function mappedUnroutable(tail: string): boolean
{
    if (tail.includes("."))
    {
        return addressUnroutable(tail);
    }

    const groups = tail.split(":");

    if (groups.length !== 2)
    {
        return true;
    }

    const [high, low] = groups.map((each) => Number.parseInt(each, 16));

    if (high === undefined || low === undefined || Number.isNaN(high) || Number.isNaN(low))
    {
        return true;
    }

    return fourUnroutable([
        Math.floor(high / 256) % 256,
        high % 256,
        Math.floor(low / 256) % 256,
        low % 256,
    ]);
}

/** The four octets a host names, however it spells them. */
function asFour(host: string): number[] | undefined
{
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);

    if (dotted !== null)
    {
        const parts = dotted.slice(1).map(Number);

        return parts.every((each) => each <= 255) ? parts : undefined;
    }

    const packed = asNumber(host);

    if (packed === undefined)
    {
        return undefined;
    }

    return [
        Math.floor(packed / 16_777_216) % 256,
        Math.floor(packed / 65_536) % 256,
        Math.floor(packed / 256) % 256,
        packed % 256,
    ];
}

// 2130706433, 0x7f000001, 0177.0.0.1 and 127.1 are all 127.0.0.1, and every
// one of them reaches it.
function asNumber(host: string): number | undefined
{
    const whole = /^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/u.exec(host);

    if (whole !== null)
    {
        const value = host.startsWith("0x")
            ? Number.parseInt(host.slice(2), 16)
            : (/^0[0-7]+$/u.test(host) ? Number.parseInt(host, 8) : Number(host));

        return Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295 ? value : undefined;
    }

    const shortened = /^(\d+)\.(\d+)\.(\d+)$|^(\d+)\.(\d+)$/u.exec(host);

    if (shortened === null)
    {
        return undefined;
    }

    const parts = shortened.slice(1).filter((each) => each !== undefined).map(Number);
    const last = parts.at(-1) ?? 0;
    const leading = parts.slice(0, -1);

    if (leading.some((each) => each > 255))
    {
        return undefined;
    }

    let value = 0;

    for (const each of leading)
    {
        value = value * 256 + each;
    }

    return value * 256 ** (4 - parts.length) + last;
}
