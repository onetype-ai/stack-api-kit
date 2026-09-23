import { KernelFault } from "./faults";
import { blockedUrlReason, refusalReasonOf, type RefusalReason } from "./privateAddress";
import { publicAddressOf, systemLookup, type Lookup } from "./resolve";

/** What `ctx.fetch` to "anywhere" would do with an address: dial it, or refuse it and why. */
export type EgressVerdict = { allowed: true } | { allowed: false; reason: RefusalReason };

/**
 * The dial's own check, for the moment an address is saved: a row whose url passes here is one the
 * kernel will reach, and one refused here would be refused at the dial, by the same rules. The name is
 * resolved now; the dial checks it again, since what it resolves to may change.
 */
export const Egress = {
    check: async (url: string, lookup: Lookup = systemLookup): Promise<EgressVerdict> =>
    {
        if (blockedUrlReason(url) !== undefined)
        {
            return { allowed: false, reason: refusalReasonOf(url) };
        }

        try
        {
            await publicAddressOf(new URL(url.trim()).hostname, lookup, "egress");

            return { allowed: true };
        }
        catch (cause)
        {
            const reason = cause instanceof KernelFault ? cause.detail["reason"] : undefined;

            return { allowed: false, reason: reason === "unresolvable" || reason === "blocked_address" ? reason : "refused_url" };
        }
    },
};
