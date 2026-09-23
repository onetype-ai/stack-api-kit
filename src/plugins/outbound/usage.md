# outbound

## Description

Calls to another server: timeouts, a bounded answer, and one error shape. The
kernel decides which hosts a plugin may reach; this carries the call.

## Purpose

A plugin calling `fetch` itself gets no timeout, no size limit, and follows a
redirect anywhere: how a slow partner becomes an outage, and a permitted host
hands the call to one nobody declared.

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
- `"anywhere"` resolves the name, refuses it if any answer is not public, and
  dials the address it checked. `detail.reason` says why a call was refused.
- Only https origins may be declared, so credentials never cross in the clear.
- A redirect is an error rather than followed: the kernel checked the first
  url and never saw the second.
- The answer is JSON; `accepts: "text"` reads a string. Declared by the
  caller, never sniffed from what came back.
- The answer is read in chunks and stops at `maxBytes`, so a body that keeps
  arriving cannot take the process down.
- `signal` cancels a call; the timeout is separate and reported apart from it.

## Refuses

An `HttpRequestError` carrying a code: `TIMEOUT`, `ABORTED`, `NETWORK`,
`TOO_LARGE`, `MALFORMED`, or `STATUS` with the status it was refused with.
`retryAfter` is the seconds a partner asked for, when it asked. Nothing else
it throws carries a header, a token, or the body that was sent.
