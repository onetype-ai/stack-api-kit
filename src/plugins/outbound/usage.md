# outbound

## Description

Calls to another server: timeouts, a bounded answer, and one error shape. The
kernel decides which hosts a plugin may reach; this carries the call.

## Purpose

A plugin calling `fetch` itself gets no timeout, no size limit, and follows a
redirect anywhere. One of those is how a slow third party becomes an outage,
and another is how a permitted host hands the request to one nobody declared.

## Usage

```ts
const kernel = createKernel({ plugins, dial: dial({ timeoutMs: 10_000 }) });
```

```ts
export default definePlugin("billing", {
    outbound: ["https://api.stripe.com"],
    services: (ctx) => ({
        charge: (id: string) => ctx.fetch({ method: "POST", url: `https://api.stripe.com/v1/charges/${id}` }),
    }),
});
```

- `ctx.fetch` refuses any host the plugin did not declare, before it dials.
- Only https origins may be declared, so credentials never cross in the clear.
- A redirect is an error rather than followed: the kernel checked the first
  url and never saw the second.
- The answer is read in chunks and stops at `maxBytes`, so a body that keeps
  arriving cannot take the process down.
- `signal` cancels a call; the timeout is separate and reported apart from it.

## Refuses

An `OutboundFault` carrying a code: `TIMEOUT`, `ABORTED`, `NETWORK`,
`TOO_LARGE`, `MALFORMED`, or `STATUS` with the status it was refused with.
Nothing it throws carries a header, a token, or the body that was sent.
