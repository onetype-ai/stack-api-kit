import { expect, test } from "vitest";

import { definePlugin, OutboundFault } from "../../index";
import { startTestKernel } from "../startTestKernel";

test("answers may throw an OutboundFault, so a bad status is testable", async () =>
{
    const plugin = definePlugin("partner", {
        version: "1.0.0",
        describe: "Calls a partner.",
        outbound: ["https://partner.test"],
        services: (ctx) => ({
            ask: () => ctx.fetch({ method: "GET", url: "https://partner.test/thing" }),
        }),
    });

    const api = await startTestKernel({
        plugins: [plugin],
        answers: () =>
        {
            throw new OutboundFault("STATUS", "The call was refused with status 503.", 503);
        },
    });

    const failed = await (api.kernel.context("partner").services as { ask: () => Promise<unknown> })
        .ask()
        .catch((cause: unknown) => cause) as OutboundFault;

    await api.stop();

    expect(failed).toBeInstanceOf(OutboundFault);
    expect(failed.status).toBe(503);
});
