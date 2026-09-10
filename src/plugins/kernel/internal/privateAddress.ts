/** Whether an address is one the outside world may be reached at. */

/** Ports the web is served on. Anything else is a service, not a site. */
const WEB_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Names that resolve to this machine whatever the resolver says. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
]);

/** Why this url may not be dialled, or undefined when it may. */
export function blockedUrlReason(rawUrl: string): string | undefined
{
    let url: URL;

    try
    {
        url = new URL(rawUrl.trim());
    }
    catch
    {
        return `"" is not an address.`;
    }

    if (url.protocol !== "https:")
    {
        return "ctx.fetch speaks https and nothing else.";
    }

    if (!WEB_PORTS.has(url.port === "" ? 443 : Number(url.port)))
    {
        return `Port ${url.port} is not one the web is served on.`;
    }

    if (url.username !== "" || url.password !== "")
    {
        return "An address carrying a credential is refused.";
    }

    return isPrivateHost(url.hostname) ? "That address is not on the public internet." : undefined;
}

/** Whether a host, written any of the ways it can be, is not public. */
export function isPrivateHost(rawHost: string): boolean
{
    const host = rawHost.toLowerCase().replace(/\.$/u, "");

    if (host === "" || LOOPBACK_NAMES.has(host))
    {
        return true;
    }

    if (host.startsWith("[") || host.includes(":"))
    {
        return isPrivateIpv6(host.replace(/^\[|\]$/gu, ""));
    }

    const octets = toIpv4Octets(host);

    return octets === undefined ? false : isPrivateIpv4(octets);
}

/** Whether a resolved address is not public. Anything unreadable is not. */
export function isPrivateIp(address: string): boolean
{
    if (address.includes(":"))
    {
        return isPrivateIpv6(address);
    }

    const octets = toIpv4Octets(address);

    return octets === undefined ? true : isPrivateIpv4(octets);
}

function isPrivateIpv4(octets: readonly number[]): boolean
{
    const [first = 0, second = 0] = octets;

    if (first === 0 || first === 10 || first === 127)
    {
        return true;
    }

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

function isPrivateIpv6(rawAddress: string): boolean
{
    const address = rawAddress.toLowerCase();

    if (address === "::" || address === "::1")
    {
        return true;
    }

    const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/u.exec(address);

    if (mapped?.[1] !== undefined)
    {
        return isPrivateMappedIpv4(mapped[1]);
    }

    const head = address.split(":")[0] ?? "";

    if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb"))
    {
        return true;
    }

    return head.startsWith("fc") || head.startsWith("fd");
}

function isPrivateMappedIpv4(tail: string): boolean
{
    if (tail.includes("."))
    {
        return isPrivateIp(tail);
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

    return isPrivateIpv4([
        Math.floor(high / 256) % 256,
        high % 256,
        Math.floor(low / 256) % 256,
        low % 256,
    ]);
}

/** The four octets a host names, however it spells them. */
function toIpv4Octets(host: string): number[] | undefined
{
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);

    if (dotted !== null)
    {
        const parts = dotted.slice(1).map(Number);

        return parts.every((each) => each <= 255) ? parts : undefined;
    }

    const packed = toPackedIpv4(host);

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

function toPackedIpv4(host: string): number | undefined
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
