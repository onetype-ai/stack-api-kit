# Procedure: answers

A route answers one way, declared, and the kit writes the wire.

## One answer

`output` is a whitelist: what it does not name does not leave. A
`z.record` passes only keyed by an enum, literals or an anchored pattern.

## A stream

```ts
route({
    method: "GET", path: "/items/feed", describe: "New items as they come.",
    requires: ["items.read"], input: z.object({}),
    streams: z.object({ id: z.string(), title: z.string() }),
    async *handle(_input, ctx)
    {
        for await (const item of ctx.services.items.watch(ctx.signal))
        {
            yield item;
        }
    },
});
```

Sent as Server-Sent Events. Everything is checked before the first event;
a failure after it ends the stream with an `error` event. `ctx.signal`
aborts when the caller leaves. A stream lives `streamSeconds` (300), a
caller holds at most `mostStreamsPerCaller` (4).

Declare `output` too and the route answers either: a value is JSON, an
iterable or `Reply.events` a stream.

## A page, or a download

`document: { policy }` answers `Reply.document(html)` under that policy;
framing needs `framable: true`. `file: { types: ["text/csv"] }` answers
`Reply.file(body, { type, filename })`, always an attachment.

## Headers

A reply sets location, retry-after, content-disposition, vary, etag,
cache-control and the session headers, plus what `sends` names.
`public` caching only on a public route. A 204 or 205 never has a body.
`anyOrigin: true` lets any site read a public GET, with no credentials.

## Refuses

- Two ways to answer, except output with streams.
- An output or streams schema that cannot filter.
- A policy with `'unsafe-eval'`, inline script, or framing undeclared.
- A file type a browser would run.
