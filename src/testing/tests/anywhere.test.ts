import { expect, test } from "vitest";

import { definePlugin } from "../../index";
import { startTestKernel } from "../startTestKernel";

/** A plugin whose hosts are rows: it crawls whatever a customer typed. */
const crawler = definePlugin("crawler", {
    version: "1.0.0",
    describe: "Reads a page at an address a customer chose.",
    outbound: "anywhere",
    services: (ctx) => ({
        read: (url: string) => ctx.fetch({ method: "GET", url, accepts: "text" }),
    }),
});

async function reading(): Promise<{ read: (url: string) => Promise<unknown>; stop: () => Promise<void> }>
{
    const api = await startTestKernel({ plugins: [crawler], answers: () => "<html></html>" });
    const services = api.kernel.context("crawler").services as { read: (url: string) => Promise<unknown> };

    return { read: services.read, stop: api.stop };
}

test("anywhere reaches a site nobody could have named", async () =>
{
    const { read, stop } = await reading();

    await expect(read("https://a-customer-typed-this.test/page")).resolves.toBe("<html></html>");

    await stop();
});

test("anywhere still refuses the machine it runs on, however it is spelled", async () =>
{
    const { read, stop } = await reading();

    for (const url of [
        "https://127.0.0.1/",
        "https://localhost/",
        "https://0x7f000001/",
        "https://[::ffff:127.0.0.1]/",
        "https://169.254.169.254/latest/meta-data/",
        "https://10.0.0.5/",
    ])
    {
        await expect(read(url), url).rejects.toMatchObject({ code: "UNDECLARED_HOST" });
    }

    await stop();
});

test("anywhere still refuses a scheme, a port and a credential", async () =>
{
    const { read, stop } = await reading();

    for (const url of ["http://example.test/", "https://example.test:22/", "https://user:key@example.test/"])
    {
        await expect(read(url), url).rejects.toMatchObject({ code: "UNDECLARED_HOST" });
    }

    await stop();
});
