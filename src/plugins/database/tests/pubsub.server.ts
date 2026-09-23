import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../kernel/api";
import { start } from "../../mount/api";
import { createIdentity } from "../../../testing/startTestKernel";
import { postgresPubSub } from "../api";

import type { Identity, PubSub } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

// What only a real server shows: two processes' LISTEN and NOTIFY, a long text through a row, a dropped connection.
const url = process.env["KIT_PG_URL"];

if (url === undefined || url === "")
{
    throw new Error("KIT_PG_URL is not set, so there is no Postgres server to test against. Run infra/remote-verify.sh --with-pg --lane kit <kit> \"pnpm test:pg\".");
}

const opened: PubSub[] = [];
const apps: StartedApp[] = [];

afterEach(async () =>
{
    for (const app of apps.splice(0))
    {
        await app.stop();
    }

    for (const pubsub of opened.splice(0))
    {
        await pubsub.close();
    }
});

const open = async (timing = {}): Promise<PubSub> =>
{
    const pubsub = await postgresPubSub(url, undefined, timing);

    opened.push(pubsub);

    return pubsub;
};

async function until(isMet: () => boolean, limitMs = 10_000): Promise<void>
{
    const end = Date.now() + limitMs;

    while (!isMet() && Date.now() < end)
    {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test("what one process publishes, another hears", async () =>
{
    const first = await open();
    const second = await open();
    const heard: string[] = [];
    const topic = `probe.${crypto.randomUUID()}`;

    second.subscribe(topic, (text) => heard.push(text));
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.publish(topic, "hello");
    await until(() => heard.length > 0);

    expect(heard).toEqual(["hello"]);
});

test("a text longer than a notification holds crosses through a row, which is swept after it is read", async () =>
{
    const first = await open({ keepMs: 200, sweepMs: 100 });
    const second = await open();
    const heard: string[] = [];
    const topic = `probe.${crypto.randomUUID()}`;
    const long = "x".repeat(20_000);

    second.subscribe(topic, (text) => heard.push(text));
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.publish(topic, long);
    await until(() => heard.length > 0);

    const { default: pg } = await import("pg");
    const reader = new pg.Client({ connectionString: url });
    await reader.connect();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const left = await reader.query(`SELECT count(*)::int AS "count" FROM "kit_pushes" WHERE "at" < $1`, [Date.now() - 200]);
    await reader.end();

    expect(heard).toEqual([long]);
    expect(left.rows[0]).toEqual({ count: 0 });
});

test("topics subscribed at once are each listened to, one query at a time: all hear, and pg warns of nothing", async () =>
{
    const warnings: string[] = [];
    const warned = (warning: Error): void =>
    {
        warnings.push(warning.message);
    };
    process.on("warning", warned);

    try
    {
        const first = await open();
        const second = await open();
        const topics = [0, 1, 2, 3, 4].map(() => `probe.${crypto.randomUUID()}`);
        const heard = new Set<string>();

        for (const topic of topics)
        {
            second.subscribe(topic, (text) => heard.add(text));
        }

        await until(() =>
        {
            for (const topic of topics)
            {
                first.publish(topic, topic);
            }

            return heard.size === topics.length;
        });

        expect([...heard].sort()).toEqual([...topics].sort());
        expect(warnings.filter((message) => message.includes("already executing a query"))).toEqual([]);
    }
    finally
    {
        process.off("warning", warned);
    }
});

test("a listening connection the server dropped is opened again, listens to every topic afresh, and hears what is published after", async () =>
{
    const first = await open();
    const second = await open();
    const topics = [`probe.${crypto.randomUUID()}`, `probe.${crypto.randomUUID()}`, `probe.${crypto.randomUUID()}`];
    const heard = new Set<string>();

    for (const topic of topics)
    {
        second.subscribe(topic, (text) => heard.add(text));
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    const { default: pg } = await import("pg");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const killed = await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
    await admin.end();

    await until(() =>
    {
        for (const topic of topics)
        {
            first.publish(topic, `after ${topic}`);
        }

        return heard.size === topics.length;
    }, 15_000);

    expect(killed.rowCount).toBeGreaterThan(0);
    expect([...heard].sort()).toEqual(topics.map((topic) => `after ${topic}`).sort());
});

const desk = definePlugin("desk", {
    version: "1.0.0",
    describe: "Tells a workspace its queue, and replies to one person.",
    scope: { describe: "A workspace's desk.", claim: "workspace", tables: {} },
    channels: {
        "desk.queue": { describe: "The workspace's queue.", schema: z.object({ size: z.number() }), reach: "scope" },
        "desk.reply": { describe: "A reply for one person.", schema: z.object({ text: z.string() }), reach: "identity" },
    },
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const person = (id: string, workspace: string): Identity => createIdentity([], id, { workspace });

const serve = async (): Promise<StartedApp> =>
{
    const app = await start({ plugins: [desk], database: { dialect: "postgres", url }, sockets: { claim: "workspace" } });

    apps.push(app);

    return app;
};

const listen = (app: StartedApp, identity: Identity, channel: string): unknown[] =>
{
    const heard: unknown[] = [];

    app.sockets!.subscribe(identity, (text) => heard.push(JSON.parse(text))).listen(channel);

    return heard;
};

test("two servers on one database: a push reaches its workspace in the other, never another workspace, and one person only", async () =>
{
    const first = await serve();
    const second = await serve();
    const sameWorkspace = listen(second, person("agent-1", A), "desk.queue");
    const otherWorkspace = listen(second, person("agent-2", B), "desk.queue");
    const named = listen(second, person("visitor-1", A), "desk.reply");
    const bystander = listen(second, person("visitor-2", A), "desk.reply");
    await new Promise((resolve) => setTimeout(resolve, 200));

    first.kernel.context("desk", person("agent-3", A)).push("desk.queue", { size: 2 });
    first.kernel.context("desk", person("agent-3", A)).push("desk.reply", { text: "hi" }, { to: "visitor-1" });
    await until(() => sameWorkspace.length > 0 && named.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sameWorkspace).toEqual([{ channel: "desk.queue", body: { size: 2 } }]);
    expect(otherWorkspace).toEqual([]);
    expect(named).toEqual([{ channel: "desk.reply", body: { text: "hi" } }]);
    expect(bystander).toEqual([]);
});

test("a notification that is not what the kit sends reaches nobody, one naming another tenant reaches that tenant alone, and the server lives on", async () =>
{
    const receiving = await serve();
    const heard = listen(receiving, person("agent-1", A), "desk.queue");
    const otherTenant = listen(receiving, person("agent-2", B), "desk.queue");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { default: pg } = await import("pg");
    const intruder = new pg.Client({ connectionString: url });
    await intruder.connect();
    await intruder.query(`SELECT pg_notify('kit.push', '{"reach":"everyone","channel":"desk.queue","message":{"size":9}}')`);
    await intruder.query(`SELECT pg_notify('kit.push', 'not json at all')`);
    for (const forged of [{ reach: "scope" }, { reach: "identity", scope: A }, { reach: "viewer" }])
    {
        await intruder.query("SELECT pg_notify('kit.push', $1)", [JSON.stringify({ origin: "forger", channel: "desk.queue", requires: [], message: { size: 7 }, ...forged })]);
    }

    await intruder.query("SELECT pg_notify('kit.push', $1)", [JSON.stringify({ origin: "forger", channel: "desk.queue", reach: "scope", scope: B, requires: [], message: { size: 8 } })]);
    await intruder.end();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(heard).toEqual([]);
    expect(otherTenant).toEqual([{ channel: "desk.queue", body: { size: 8 } }]);
    expect(receiving.kernel.started()).toBe(true);
});
