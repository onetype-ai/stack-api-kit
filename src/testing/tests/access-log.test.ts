import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, start } from "../../index";

import type { StartedApp } from "../../index";

type Line = { level: string; line: string; about: Readonly<Record<string, unknown>> | undefined };

const items = definePlugin("items", {
    version: "1.0.0",
    describe: "Answers one item, and says so in the log.",
    routes: [{
        method: "GET",
        path: "/items/:id",
        describe: "Reads one.",
        public: true,
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string() }),
        handle: (input: { id: string }, ctx: { log: { info: (line: string) => void } }) =>
        {
            ctx.log.info("read an item");

            return { id: input.id };
        },
    }],
} as unknown as Parameters<typeof definePlugin>[1]);

let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

async function serving(): Promise<{ lines: Line[]; running: StartedApp }>
{
    const lines: Line[] = [];
    const record = (level: string) => (line: string, about?: Readonly<Record<string, unknown>>): void => { lines.push({ level, line, about }); };

    app = await start({ plugins: [items], log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } });

    return { lines, running: app };
}

test("a request leaves one line with the route's pattern, never the path it was asked by", async () =>
{
    const { lines, running } = await serving();

    const response = await running.fetch(new Request("http://localhost/items/secret-token-123"));
    const access = lines.filter((line) => line.line === "request");

    expect(access).toEqual([{ level: "info", line: "request", about: { requestId: response.headers.get("x-request-id"), method: "GET", path: "/items/:id", status: 200, durationMs: expect.any(Number) } }]);
    expect(JSON.stringify(lines)).not.toContain("secret-token-123");
});

test("every line a plugin writes while serving a request names that request", async () =>
{
    const { lines, running } = await serving();

    const response = await running.fetch(new Request("http://localhost/items/1", { headers: { "x-request-id": "trace-1" } }));
    const written = lines.find((line) => line.line.endsWith("read an item"));

    expect(response.headers.get("x-request-id")).toBe("trace-1");
    expect(written?.about).toMatchObject({ requestId: "trace-1" });
});

test("a probe that answers leaves no line", async () =>
{
    const { lines, running } = await serving();

    await running.fetch(new Request("http://localhost/health"));

    expect(lines.filter((line) => line.line === "request")).toEqual([]);
});

test("a path no route declares is logged as unmatched, whatever it carries", async () =>
{
    const { lines, running } = await serving();

    await running.fetch(new Request("http://localhost/tok_PLANTED/ana@example.test"));
    const access = lines.filter((line) => line.line === "request");

    expect(access.map((line) => line.about?.["path"])).toEqual(["(unmatched)"]);
    expect(JSON.stringify(lines)).not.toMatch(/tok_PLANTED|ana@example/u);
});
