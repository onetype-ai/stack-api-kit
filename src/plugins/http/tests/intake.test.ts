import { describe, expect, test } from "vitest";

import { createKernel } from "../../kernel/api";
import { serve } from "../api";

type Line = { level: string; line: string; about: Readonly<Record<string, unknown>> | undefined };

async function serving(options: Partial<Parameters<typeof serve>[0]>): Promise<{ app: ReturnType<typeof serve>; lines: Line[] }>
{
    const kernel = createKernel({ plugins: [] });
    const lines: Line[] = [];

    await kernel.start();

    return { app: serve({ kernel, log: (level, line, about) => lines.push({ level, line, about }), from: () => "203.0.113.7", ...options }), lines };
}

const report = (body: unknown): Request => new Request("http://localhost/client-logs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("reports from a browser", () =>
{
    test("are not taken unless asked for", async () =>
    {
        const { app } = await serving({});

        expect((await app.fetch(report({ level: "error", message: "boom" }))).status).toBe(404);
    });

    test("reach the log as one line, and nothing else", async () =>
    {
        const { app, lines } = await serving({ clientLogs: {} });

        const response = await app.fetch(report({ level: "error", message: "render failed", page: "/items", detail: { code: "E1" } }));

        expect(response.status).toBe(204);
        expect(lines.filter((line) => line.line.startsWith("client:"))).toEqual([{ level: "error", line: "client: render failed", about: { client: true, page: "/items", detail: { code: "E1" } } }]);
    });

    test.each([
        ["a field it does not know", { level: "error", message: "x", secret: "y" }, 400],
        ["a level it does not take", { level: "info", message: "x" }, 400],
        ["a report over its bound", { level: "error", message: "x".repeat(20_000) }, 413],
    ])("refuses %s", async (_what, body, status) =>
    {
        const { app } = await serving({ clientLogs: {} });

        expect((await app.fetch(report(body))).status).toBe(status);
    });

    test("counts each address, and refuses past its budget", async () =>
    {
        const { app } = await serving({ clientLogs: { requests: 2 } });
        const statuses: number[] = [];

        for (let sent = 0; sent < 3; sent += 1)
        {
            statuses.push((await app.fetch(report({ level: "warn", message: "slow" }))).status);
        }

        expect(statuses).toEqual([204, 204, 429]);
    });
});

test("HSTS is sent only when asked for, as asked", async () =>
{
    const { app: plain } = await serving({});
    const { app: strict } = await serving({ hsts: { maxAge: 31_536_000, includeSubDomains: true } });

    expect((await plain.fetch(new Request("http://localhost/live"))).headers.get("strict-transport-security")).toBeNull();
    expect((await strict.fetch(new Request("http://localhost/live"))).headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
});
