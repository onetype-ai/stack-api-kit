import { expect, test } from "vitest";
import { z } from "zod";
import { definePlugin } from "../../plugins/kernel/api";
import { startTestKernel } from "../startTestKernel";
import type { Definition } from "../../plugins/kernel/api";

const partner = definePlugin("partner", {
    version: "1.0.0", describe: "Talks to a paid service.",
    outbound: ["https://api.stripe.com"],
    routes: [{
        method: "POST", path: "/charge", describe: "Charges.",
        public: true,
        input: z.object({}), output: z.object({ ok: z.boolean() }),
        handle: async (_given: unknown, ctx: { fetch: (call: unknown) => Promise<unknown> }) =>
        {
            await ctx.fetch({
                method: "POST",
                url: "https://api.stripe.com/v1/charges",
                headers: { authorization: "Bearer sk_live_SECRET", "x-idempotency": "abc" },
            });

            return { ok: true };
        },
    }],
} as Partial<Definition> as Definition);

test("a recorded call keeps the credential out of what a failing test prints", async () =>
{
    const api = await startTestKernel({ plugins: [partner], answers: () => ({}) });

    await api.kernel.handle({ method: "POST", path: "/charge", input: {} });

    const [call] = api.outboundCalls();

    await api.stop();

    // Ovo je dokaz koji D15 trazi: kljuc je otisao SVOM hostu.
    expect(call?.url).toBe("https://api.stripe.com/v1/charges");
    expect(Object.keys(call?.headers ?? {})).toContain("authorization");

    // A vrednost se ne ispisuje.
    expect(call?.headers?.["authorization"]).toBe("[redacted]");
    expect(JSON.stringify(call)).not.toContain("sk_live_SECRET");

    // Sto nije kredencijal, ostaje citljivo.
    expect(call?.headers?.["x-idempotency"]).toBe("abc");
});

test("and a header that carries nothing secret is left readable", async () =>
{
    const api = await startTestKernel({ plugins: [partner], answers: () => ({}) });

    await api.kernel.handle({ method: "POST", path: "/charge", input: {} });

    const [call] = api.outboundCalls();

    await api.stop();

    expect(call?.headers?.["x-idempotency"]).toBe("abc");
    expect(Object.keys(call?.headers ?? {})).toEqual(["authorization", "x-idempotency"]);
});
