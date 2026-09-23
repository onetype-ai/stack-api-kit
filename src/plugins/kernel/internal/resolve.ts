import { lookup as dnsLookup } from "node:dns/promises";

import { KernelFault } from "./faults";
import { isPrivateIp, toIpv4Octets } from "./privateAddress";

/** One address a name resolves to. */
export type ResolvedAddress = {
    address: string;
    family: number;
};

/** How a name becomes addresses: every one of them, as `dns.lookup(name, { all: true })` answers. */
export type Lookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The platform's resolver, asked for every answer in the order it gives them. */
export const systemLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The address a call to this host is dialled at.
 *
 * Every answer is checked, because one private answer is enough to reach inside, and the
 * address checked is the one dialled, so a second lookup answering differently (a rebinding)
 * reaches nothing the check did not see.
 */
export async function publicAddressOf(rawHost: string, lookup: Lookup, plugin: string): Promise<ResolvedAddress>
{
    const host = rawHost.replace(/^\[|\]$/gu, "");

    if (toIpv4Octets(host) !== undefined || host.includes(":"))
    {
        return { address: host, family: host.includes(":") ? 6 : 4 };
    }

    let answers: readonly ResolvedAddress[];

    try
    {
        answers = await lookup(host);
    }
    catch (cause)
    {
        throw new KernelFault("UNDECLARED_HOST", `"${plugin}" called ${host}, which did not resolve.`, { plugin, cause, detail: { reason: "unresolvable" } });
    }

    const first = answers[0];

    if (first === undefined)
    {
        throw new KernelFault("UNDECLARED_HOST", `"${plugin}" called ${host}, which did not resolve.`, { plugin, detail: { reason: "unresolvable" } });
    }

    if (answers.some((answer) => isPrivateIp(answer.address)))
    {
        throw new KernelFault("UNDECLARED_HOST", `"${plugin}" called ${host}, which resolves to an address not on the public internet.`, { plugin, detail: { reason: "blocked_address" } });
    }

    return { address: first.address, family: first.family };
}
