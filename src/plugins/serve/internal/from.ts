import { BlockList, isIP } from "node:net";

/** What a request carries, as far as reading a header and the socket it came on goes. */
export type HeaderCarrier = {
    req: { header: (name: string) => string | undefined };
    env?: unknown;
};

/** Who a deployment trusts to write `x-forwarded-for`: nobody, anyone (the first hop, as before 8.2), or the proxies named. */
export type Trusting = false | { trustedProxies: readonly string[] };

/** Node reports an IPv4 caller on a dual-stack socket as ::ffff:a.b.c.d. */
function plain(address: string): string
{
    return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

/** The addresses and ranges named, as a list the platform checks; a name that is neither is refused. */
export function trustedList(proxies: readonly string[]): BlockList
{
    const list = new BlockList();

    for (const proxy of proxies)
    {
        const [address = "", prefix] = proxy.split("/");
        const family = isIP(address);

        if (family === 0 || (prefix !== undefined && (!/^\d{1,3}$/u.test(prefix) || Number(prefix) > (family === 6 ? 128 : 32))))
        {
            throw new TypeError(`trustedProxies: "${proxy}" is not an address or a range. Name each proxy as an address (10.0.0.1) or a range (10.0.0.0/8).`);
        }

        if (prefix === undefined)
        {
            list.addAddress(address, family === 6 ? "ipv6" : "ipv4");
        }
        else
        {
            list.addSubnet(address, Number(prefix), family === 6 ? "ipv6" : "ipv4");
        }
    }

    return list;
}

/**
 * The client's address: the hops walked from the one nearest us outwards, answering the first that is not a
 * proxy we trust. Every hop to its left was written by whoever sent that hop's request, so none can be
 * believed; without the socket peer nothing is known, since the header alone is the caller's word.
 */
export function addressOf(forwarded: string | undefined, peer: string | undefined, trusted: BlockList): string | undefined
{
    if (peer === undefined)
    {
        return undefined;
    }

    const hops = [...(forwarded ?? "").split(",").map((hop) => hop.trim()).filter(Boolean), plain(peer)];

    for (let index = hops.length - 1; index >= 0; index -= 1)
    {
        const hop = hops[index] ?? "";
        const family = isIP(hop);

        if (family === 0)
        {
            return undefined;
        }

        if (index === 0 || !trusted.check(hop, family === 6 ? "ipv6" : "ipv4"))
        {
            return hop;
        }
    }

    return undefined;
}

/** The socket a request came in on, where the Node adapter says. */
function peerOf(carrier: HeaderCarrier): string | undefined
{
    const address = (carrier.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)?.incoming?.socket?.remoteAddress;

    return typeof address === "string" && address !== "" ? address : undefined;
}

/**
 * Who a rate limit counts an unknown caller by.
 *
 * With `{ trustedProxies }` it is the rightmost address in `x-forwarded-for` that no named proxy wrote, from the
 * socket outwards. With `false` it is the socket's own address.
 */
export function from(trusting: Trusting): (carrier: HeaderCarrier) => string
{
    // the first hop is written by the caller, so trusting it lets every caller choose whose limit it spends
    if ((trusting as unknown) === true)
    {
        throw new TypeError("serve: Server.from(true) is gone in 9.0: it trusted the first x-forwarded-for hop, which a caller writes, so a caller chose whose rate limit it spent. Name the proxies in front: Server.from({ trustedProxies: [\"10.0.0.0/8\"] }), or from(false) for none.");
    }

    if (typeof trusting === "object")
    {
        const trusted = trustedList(trusting.trustedProxies);

        return (carrier: HeaderCarrier): string => addressOf(carrier.req.header("x-forwarded-for"), peerOf(carrier), trusted) ?? "anonymous";
    }

    return (carrier: HeaderCarrier): string =>
    {
        const peer = peerOf(carrier);

        return peer !== undefined ? plain(peer) : "anonymous";
    };
}
