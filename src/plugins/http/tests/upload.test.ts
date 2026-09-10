import { describe, expect, test } from "vitest";
import { z } from "zod";

import { createKernel, definePlugin } from "../../kernel/api";
import { serve, isUploadedFile } from "../api";
import { claimedName } from "../internal/upload";

import type { Definition } from "../../kernel/api";
import type { UploadedFile } from "../api";

/** What a route sees, heard by the last request to reach one. */
let seen: unknown;

const file = z.custom<UploadedFile>(isUploadedFile, { message: "Expected a file." });

async function startServer(found: Partial<Definition>)
{
    const kernel = createKernel({
        plugins: [definePlugin("files", { version: "1.0.0", describe: "Takes files.", ...found } as Definition)],
    });

    await kernel.start();

    return serve({ kernel, bodyBytes: 1_000_000 });
}

/** One route reading a form: a named file and a text field beside it. */
const takesForm = {
    routes: [{
        method: "POST" as const,
        path: "/upload",
        describe: "Takes one file.",
        public: true,
        accepts: "form" as const,
        input: z.object({ note: z.string().optional(), photo: file }),
        output: z.object({ name: z.string(), type: z.string(), bytes: z.number() }),
        handle: (given: { note?: string; photo: UploadedFile }) =>
        {
            seen = given;

            return { name: given.photo.name, type: given.photo.type, bytes: given.photo.bytes.byteLength };
        },
    }],
};

function form(parts: readonly { name: string; filename?: string; type?: string; body: string }[]): Request
{
    const boundary = "----kit";

    const written = parts.map((part) =>
    {
        const disposition = part.filename === undefined
            ? `form-data; name="${part.name}"`
            : `form-data; name="${part.name}"; filename="${part.filename}"`;

        const type = part.type === undefined ? "" : `Content-Type: ${part.type}\r\n`;

        return `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n${part.body}`;
    });

    return new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: `${written.join("\r\n")}\r\n--${boundary}--\r\n`,
    });
}

describe("a route that reads a form", () =>
{
    test("hands the file to the handler with its bytes", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(form([
            { name: "note", body: "a picture" },
            { name: "photo", filename: "cat.png", type: "image/png", body: "BYTES" },
        ]));

        expect(answer.status).toBe(201);
        expect(await answer.json()).toEqual({ name: "cat.png", type: "image/png", bytes: 5 });
    });

    test("and the text parts beside it reach the same schema", async () =>
    {
        const app = await startServer(takesForm);

        await app.fetch(form([
            { name: "note", body: "a picture" },
            { name: "photo", filename: "cat.png", type: "image/png", body: "BYTES" },
        ]));

        expect((seen as { note: string }).note).toBe("a picture");
    });

    test("refuses a JSON body, saying what it reads", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(new Request("http://localhost/upload", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: "no file here" }),
        }));

        expect(answer.status).toBe(415);
        expect((await answer.json() as { code: string }).code).toBe("UNSUPPORTED_BODY");
    });
});

describe("a route that reads JSON", () =>
{
    test("cannot be handed a file, whatever the form says", async () =>
    {
        const app = await startServer({
            routes: [{
                method: "POST", path: "/upload", describe: "Takes JSON.", public: true,
                input: z.object({ note: z.string() }),
                output: z.object({ ok: z.boolean() }),
                handle: () => ({ ok: true }),
            }],
        });

        const answer = await app.fetch(form([{ name: "note", body: "sneaky" }]));

        expect(answer.status).toBe(415);
    });
});

describe("a filename is the caller's claim", () =>
{
    test("and never a path: what walks out of a directory is stripped", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(form([
            { name: "photo", filename: "../../etc/passwd", type: "image/png", body: "X" },
        ]));

        expect((await answer.json() as { name: string }).name).toBe("passwd");
    });

    test("including a windows path, which a server on linux still receives", () =>
    {
        expect(claimedName("..\\..\\windows\\system32\\config")).toBe("config");
    });

    test("and a name that is nothing but a walk is nothing at all", () =>
    {
        expect(claimedName("..")).toBe("");
        expect(claimedName("../")).toBe("");
    });

    test("a plain name survives untouched", () =>
    {
        expect(claimedName("holiday photo.png")).toBe("holiday photo.png");
    });
});

describe("what a schema still has to check", () =>
{
    test("a file field a caller sent as text is refused, not read as one", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(form([{ name: "photo", body: "not a file" }]));

        expect(answer.status).toBe(400);
    });

    test("and a missing file is refused by the schema, not by a crash", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(form([{ name: "note", body: "alone" }]));

        expect(answer.status).toBe(400);
    });
});

describe("a form larger than the body limit", () =>
{
    test("is refused before anything parses it", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(form([
            { name: "photo", filename: "big.bin", type: "application/octet-stream", body: "x".repeat(1_100_000) },
        ]));

        expect(answer.status).toBe(413);
    });
});

describe("a form body nothing can parse", () =>
{
    test("is the caller's mistake, not the server's", async () =>
    {
        const app = await startServer(takesForm);

        const answer = await app.fetch(new Request("http://localhost/upload", {
            method: "POST",
            headers: { "content-type": "multipart/form-data; boundary=----kit" },
            body: "--nothing-like-the-boundary\r\ntorn",
        }));

        expect(answer.status).toBe(400);
        expect(await answer.json()).toMatchObject({ code: "INVALID_FORM" });
    });
});
