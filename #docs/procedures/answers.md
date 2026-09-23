# Procedure: answers

A route answers one declared way; the kit writes the wire.

## One answer

`output` is a whitelist. A `z.record` passes keyed by an enum or pattern.

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

Sent as Server-Sent Events, all checks done before the first; a failure
after it ends with an `error` event. `ctx.signal` aborts when the caller
leaves. A stream lives `streamSeconds` (300); a caller holds at most 4.

With `output` too it answers either: a value as JSON, an iterable as events.

## A page, or a download

`document: { policy }` answers `Reply.document(html)` under that policy;
framing needs `framable: true`. `file: { types: ["text/csv"] }` answers
`Reply.file(body, { type, filename })`, always an attachment; `Reply.csv(rows,
{ columns, filename })` keeps formula-looking cells as text.

## Headers

`strictReplyHeaders: true` (9.0's default) lets a reply set location,
retry-after, content-disposition, vary, etag, cache-control and the session
headers, plus what `sends` names. `public` caching only on a public route; a
204 never has a body. `Refusal(…, { retryAfter })` sends retry-after, and
`limit.key` counts by `"address"` or a function of the input. `anyOrigin`
lets any site read a public GET, without credentials.

## Refuses

- Two ways to answer, except output with streams; a schema that cannot filter.
- `'unsafe-eval'`, inline script, undeclared framing, or a file a browser runs.
