import { expect, test } from "vitest";

import { definePlugin, HttpRequestError } from "../../index";
import { startTestKernel } from "../startTestKernel";

test("answers may throw an HttpRequestError, so a bad status is testable", async () =>
{
    const plugin = definePlugin("partner", {
        version: "1.0.0",
        describe: "Calls a partner.",
        allowedHosts: ["https://partner.test"],
        services: (ctx) => ({
            ask: () => ctx.fetch({ method: "GET", url: "https://partner.test/thing" }),
        }),
    });

    const api = await startTestKernel({
        plugins: [plugin],
        respondWith: () =>
        {
            throw new HttpRequestError("STATUS", "The call was refused with status 503.", 503);
        },
    });

    const fault = await (api.kernel.context("partner").services as { ask: () => Promise<unknown> })
        .ask()
        .catch((cause: unknown) => cause) as HttpRequestError;

    await api.stop();

    expect(fault).toBeInstanceOf(HttpRequestError);
    expect(fault.status).toBe(503);
});
