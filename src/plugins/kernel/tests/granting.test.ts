import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../api";
import { serve } from "../../http/api";

import type { Definition } from "../api";

/** A plugin that says who is calling, reading a header the way a session would. */
const auth = definePlugin("auth", {
    version: "1.0.0",
    describe: "Knows who is calling.",
    permissions: { "auth.self": { describe: "Read your own account." } },
    identifies: (_ctx, request) =>
    {
        const key = request.headers.get("x-key");

        return key === null ? undefined : { id: `person-${key}`, claims: { key } };
    },
    grants: () => ["auth.self", "billing.manage"],
    mayGrant: ["auth.self", "billing.manage"],
} as Partial<Definition> as Definition);

/** One that declares a permission and a route needing it. */
const billing = definePlugin("billing", {
    version: "1.0.0",
    describe: "Owns invoices.",
    permissions: { "billing.manage": { describe: "Manage invoices." } },
    routes: [{
        method: "GET", path: "/invoices", describe: "Lists invoices.",
        requires: ["billing.manage"],
        input: z.object({}), output: z.object({ who: z.string() }),
        handle: (_given: unknown, ctx: { identity?: { id: string } }) => ({ who: ctx.identity?.id ?? "nobody" }),
    }],
} as Partial<Definition> as Definition);

async function started(plugins: readonly Parameters<typeof createKernel>[0]["plugins"][number][])
{
    const kernel = createKernel({ plugins });

    await kernel.start();

    return kernel;
}

describe("a plugin that says who is calling", () =>
{
    test("is asked by the kernel, with no composition root wiring it", async () =>
    {
        const app = serve({ kernel: await started([auth, billing]) });

        const answer = await app.fetch(new Request("http://localhost/invoices", { headers: { "x-key": "ada" } }));

        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ who: "person-ada" });
    });

    test("and a request it does not recognise is a stranger, not a failure", async () =>
    {
        const app = serve({ kernel: await started([auth, billing]) });

        const answer = await app.fetch(new Request("http://localhost/invoices"));

        expect(answer.status).toBe(401);
    });

    test("cannot name its own permissions: grants fills them", async () =>
    {
        const lying = definePlugin("lying", {
            version: "1.0.0",
            describe: "Claims permissions it was never granted.",
            identifies: () => ({ id: "sneak", permissions: ["billing.manage"], claims: {} }),
        } as Partial<Definition> as Definition);

        const app = serve({ kernel: await started([lying, billing]) });

        const answer = await app.fetch(new Request("http://localhost/invoices"));

        expect(answer.status).toBe(403);
    });
});

describe("an api where nobody signs in", () =>
{
    test("starts, and every closed route answers 401", async () =>
    {
        const app = serve({ kernel: await started([billing]) });

        const answer = await app.fetch(new Request("http://localhost/invoices"));

        expect(answer.status).toBe(401);
    });
});

describe("a route requiring what nothing grants", () =>
{
    test("is refused at startup, naming the route and the permission", async () =>
    {
        const short = definePlugin("auth", {
            version: "1.0.0",
            describe: "Grants less than the routes need.",
            permissions: { "auth.self": { describe: "Read your own." } },
            grants: () => ["auth.self"],
            mayGrant: ["auth.self"],
        } as Partial<Definition> as Definition);

        const failed = await createKernel({ plugins: [short, billing] }).start().catch((cause: unknown) => cause);

        expect((failed as { code: string }).code).toBe("UNGRANTABLE_PERMISSION");
        expect((failed as Error).message).toContain("billing.manage");
        expect((failed as Error).message).toContain("/invoices");
    });

    test("and says nothing when every one of them is grantable", async () =>
    {
        await expect(createKernel({ plugins: [auth, billing] }).start()).resolves.toBeUndefined();
    });
});

describe("two plugins answering one question", () =>
{
    test("is refused: nothing decides between them", async () =>
    {
        const second = definePlugin("other", {
            version: "1.0.0",
            describe: "Also says who is calling.",
            identifies: () => undefined,
        } as Partial<Definition> as Definition);

        const failed = await createKernel({ plugins: [auth, second] }).start().catch((cause: unknown) => cause);

        expect((failed as { code: string }).code).toBe("DUPLICATE_GRANTS");
        expect((failed as Error).message).toContain("identifies");
    });
});
