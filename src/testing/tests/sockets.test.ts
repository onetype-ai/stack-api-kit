import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, start } from "../../index";
import { createIdentity, startTestKernel } from "../startTestKernel";

import type { Identity, StartedApp, Subscription } from "../../index";


const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const notes = sqliteTable("desk_notes", { id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull() });

const desk = definePlugin("desk", {
    version: "1.0.0",
    describe: "Replies to one person, and asks who is at the desk.",
    tables: { deskNotes: notes },
    migrations: "./src/testing/tests/fixtures/desk/migrations",
    scope: { describe: "A workspace's desk.", claim: "workspace", tables: { deskNotes: "workspaceId" } },
    permissions: { "desk.answer": { describe: "Answer at the desk." } },
    channels: {
        "desk.reply": { describe: "A reply for one person.", schema: z.object({ text: z.string() }), reach: "identity" },
        "desk.queue": { describe: "The workspace's queue, for those who answer.", schema: z.object({ size: z.number() }), reach: "scope", requires: ["desk.answer"] },
    },
});

let app: StartedApp | undefined;

afterEach(async () =>
{
    await app?.stop();
    app = undefined;
});

const person = (id: string, workspace: string, permissions: readonly string[] = []): Identity =>
{
    return createIdentity(permissions, id, { workspace });
};

const boot = async (): Promise<StartedApp> =>
{
    app = await start({ plugins: [desk], database: { file: ":memory:" }, sockets: { claim: "workspace" } });

    return app;
};

const open = (running: StartedApp, identity: Identity, channel: string): { heard: unknown[]; socket: Subscription } =>
{
    const heard: unknown[] = [];
    const socket = running.sockets!.subscribe(identity, (text) =>
    {
        heard.push(JSON.parse(text));
    });

    socket.listen(channel);

    return { heard, socket };
};

describe("a push to one identity", () =>
{
    test("reaches every socket that person has open in the pusher's workspace, and nobody else", async () =>
    {
        const running = await boot();
        const visitorTab = open(running, person("visitor-1", A), "desk.reply");
        const visitorPhone = open(running, person("visitor-1", A), "desk.reply");
        const someoneElse = open(running, person("visitor-2", A), "desk.reply");
        const sameIdElsewhere = open(running, person("visitor-1", B), "desk.reply");

        running.kernel.context("desk", person("operator", A, ["desk.answer"])).push("desk.reply", { text: "Hi" }, { to: "visitor-1" });

        expect(visitorTab.heard).toEqual([{ channel: "desk.reply", body: { text: "Hi" } }]);
        expect(visitorPhone.heard).toHaveLength(1);
        expect(someoneElse.heard).toEqual([]);
        expect(sameIdElsewhere.heard).toEqual([]);
    });

    test("reaches the person from a listener acting for the workspace", async () =>
    {
        const running = await boot();
        const visitor = open(running, person("visitor-1", A), "desk.reply");

        running.kernel.context("desk").forScope(A).push("desk.reply", { text: "Queued" }, { to: "visitor-1" });

        expect(visitor.heard).toHaveLength(1);
    });

    test("is refused naming nobody, and naming someone on a channel that reaches further", async () =>
    {
        const running = await boot();
        const ctx = running.kernel.context("desk", person("operator", A, ["desk.answer"]));

        expect(() =>
        {
            ctx.push("desk.reply", { text: "Hi" });
        }).toThrow("named none");
        expect(() =>
        {
            ctx.push("desk.queue", { size: 1 }, { to: "visitor-1" });
        }).toThrow("Declare reach: \"identity\"");
    });

    test("needs the plugin to declare a scope", async () =>
    {
        const scopeless = definePlugin("scopeless", {
            version: "1.0.0",
            describe: "Reaches one person with no scope to keep it in.",
            channels: { "scopeless.reply": { describe: "A reply.", schema: z.object({}), reach: "identity" } },
        });

        await expect(startTestKernel({ plugins: [scopeless] })).rejects.toThrow("reaches one identity within a scope");
    });
});

describe("presence", () =>
{
    test("answers who holding a permission has a socket open in this workspace", async () =>
    {
        const running = await boot();
        open(running, person("agent-1", A, ["desk.answer"]), "desk.queue");
        open(running, person("agent-1", A, ["desk.answer"]), "desk.queue");
        open(running, person("member-1", A), "desk.reply");
        open(running, person("agent-2", B, ["desk.answer"]), "desk.queue");

        const present = running.kernel.context("desk", person("visitor-1", A)).presence.connected("desk.answer");

        expect(present).toEqual(["agent-1"]);
    });

    test("forgets a socket once it closes", async () =>
    {
        const running = await boot();
        const agent = open(running, person("agent-1", A, ["desk.answer"]), "desk.queue");

        agent.socket.close();
        const present = running.kernel.context("desk").forScope(A).presence.connected("desk.answer");

        expect(present).toEqual([]);
    });
});

describe("a socket identified again", () =>
{
    test("stops counting as present and stops hearing once its permission is gone", async () =>
    {
        const running = await boot();
        const agent = open(running, person("agent-1", A, ["desk.answer"]), "desk.queue");

        agent.socket.reidentify(person("agent-1", A));
        running.kernel.context("desk").forScope(A).push("desk.queue", { size: 3 });
        const present = running.kernel.context("desk").forScope(A).presence.connected("desk.answer");

        expect(agent.heard).toEqual([]);
        expect(present).toEqual([]);
    });
});
