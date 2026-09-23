# outbound

## Description

Calls to another server: timeouts, a bounded answer, and one error shape. The
kernel decides which hosts a plugin may reach; this carries the call.

## Purpose

A plugin calling `fetch` itself gets no timeout, no size limit, and follows a
redirect anywhere: a slow partner becomes an outage, a permitted host hands
the call on.

## Usage

```ts
const kernel = createKernel({ plugins, httpClient: httpClient({ timeoutMs: 10_000 }) });
```

```ts
export default definePlugin("items", {
    allowedHosts: ["https://api.example.com"],
    services: (ctx) => ({
        sync: (id: string) => ctx.fetch({ method: "POST", url: `https://api.example.com/items/${id}` }),
    }),
});
```

- `ctx.fetch` refuses any host the plugin did not declare, before it dials.
  Only https origins may be declared.
- `"anywhere"` resolves the name, refuses it if any answer is not public, and
  dials the address it checked. `detail.reason` says why a call was refused.
- A redirect is an error, never followed: the kernel saw only the first url.
- The answer is JSON; `accepts: "text"` reads a string, and `"stream"` hands
  over `{ status, headers, url, body }` once the headers arrive, `body` an
  async iterable of chunks. Leaving the loop early closes it.
- `maxBytes` bounds the answer, streamed or whole. A call may pass its own
  `timeoutMs`, `maxBytes` and `idleMs` (silence between chunks); the client's
  `mostTimeoutMs` and `mostMaxBytes` cap what any call may ask for.
- `signal` cancels a call, reported apart from a timeout.

## Refuses

An `HttpRequestError` carrying a code: `TIMEOUT`, `ABORTED`, `NETWORK`,
`TOO_LARGE`, `MALFORMED`, or `STATUS` (before any streamed body), with
`retryAfter` when the partner asked. A size bounding nothing (NaN, 0) too.
