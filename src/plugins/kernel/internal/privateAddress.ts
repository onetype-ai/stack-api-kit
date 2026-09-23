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

/** Names that never leave the machine or the site (RFC 6761, RFC 6762, RFC 8375, ICANN .internal). */
const LOCAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];

/** Why a refused address was refused, for a plugin to tell its caller. */
export type RefusalReason = "unresolvable" | "blocked_address" | "refused_url";

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
        return `"${rawUrl}" is not an address.`;
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

/** Which reason a url `blockedUrlReason` refused falls under. */
export function refusalReasonOf(rawUrl: string): RefusalReason
{
    try
    {
        return isPrivateHost(new URL(rawUrl.trim()).hostname) ? "blocked_address" : "refused_url";
    }
    catch
    {
        return "refused_url";
    }
}

/** Whether a host, written any of the ways it can be, is not public. */
export function isPrivateHost(rawHost: string): boolean
{
    const host = rawHost.toLowerCase().replace(/\.$/u, "");

    if (host === "" || LOOPBACK_NAMES.has(host) || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))
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

// An allow-list rather than a deny-list: an address is public only when it is
// global unicast outside every IANA special-purpose block, so a range nobody
// thought of is refused rather than dialled.
// https://www.iana.org/assignments/iana-ipv4-special-registry
const SPECIAL_IPV4: readonly (readonly [number, number, number, number, number])[] = [
    [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8], [169, 254, 0, 0, 16],
    [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 0, 2, 0, 24], [192, 31, 196, 0, 24], [192, 52, 193, 0, 24],
    [192, 88, 99, 0, 24], [192, 168, 0, 0, 16], [192, 175, 48, 0, 24], [198, 18, 0, 0, 15], [198, 51, 100, 0, 24],
    [203, 0, 113, 0, 24], [224, 0, 0, 0, 4], [240, 0, 0, 0, 4],
];

function isPrivateIpv4(octets: readonly number[]): boolean
{
    const value = octets.reduce((packed, octet) => packed * 256 + octet, 0);

    return SPECIAL_IPV4.some(([a, b, c, d, bits]) =>
    {
        const base = ((a * 256 + b) * 256 + c) * 256 + d;

        return value >= base && value < base + 2 ** (32 - bits);
    });
}

// https://www.iana.org/assignments/iana-ipv6-special-registry: global unicast is
// 2000::/3; inside it the special blocks are refused, and an address carrying an
// IPv4 one (mapped, NAT64) is judged by the IPv4 it carries.
function isPrivateIpv6(rawAddress: string): boolean
{
    const groups = toIpv6Groups(rawAddress);

    if (groups === undefined)
    {
        return true;
    }

    const [first = 0, second = 0] = groups;
    const embedded = (): boolean => isPrivateIpv4([(groups[6] ?? 0) >> 8, (groups[6] ?? 0) & 255, (groups[7] ?? 0) >> 8, (groups[7] ?? 0) & 255]);

    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    {
        return embedded();
    }

    if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
    {
        return embedded();
    }

    if ((first & 0xe000) !== 0x2000)
    {
        return true;
    }

    // 2001::/23 (protocol assignments), 2001:db8::/32 (documentation), 2002::/16 (6to4), 3fff::/20 (documentation)
    if (first === 0x2001 && (second < 0x200 || second === 0xdb8))
    {
        return true;
    }

    return first === 0x2002 || (first === 0x3fff && second < 0x1000);
}

/** The eight groups an IPv6 address names, however it abbreviates them, or undefined when it is not one. */
function toIpv6Groups(rawAddress: string): number[] | undefined
{
    let text = rawAddress.toLowerCase().split("%")[0] ?? "";

    const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);

    if (dotted !== null)
    {
        const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);

        if ([a, b, c, d].some((octet) => octet > 255))
        {
            return undefined;
        }

        text = `${text.slice(0, dotted.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
    }

    const halves = text.split("::");

    if (halves.length > 2)
    {
        return undefined;
    }

    const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
    const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
    const missing = 8 - head.length - tail.length;

    if (halves.length === 1 ? head.length !== 8 : missing < 1)
    {
        return undefined;
    }

    const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];

    if (groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group)))
    {
        return undefined;
    }

    return groups.map((group) => Number.parseInt(group, 16));
}

/** The four octets a host names, however it spells them. */
export function toIpv4Octets(host: string): number[] | undefined
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
