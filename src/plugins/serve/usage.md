# serve

## Description

Putting a started kernel on a port, and taking it off one cleanly.

## Purpose

`start()` answers a kernel that can handle a request. Reaching it over the
network is the rest: a socket route, a signal that means stop, a watch on
listeners that failed. Every project wrote that, and a stop written wrong
loses the requests already in flight.

## Usage

```ts
import { Server } from "@onetype/stack-api-kit";

const api = await start({ ... });

await Server.open(api, {
    port: 7280,
    log,
    behindProxy: false,
    watchSeconds: 60,
});
```

`Server.open` listens, installs the signal handlers, and starts the watch.
It answers once listening; it never returns to the caller after that.

```ts
http: { from: Server.from({ trustedProxies: ["10.0.0.0/8"] }) }
Server.listen(api, port)     // the socket alone, for a caller doing its own
```

- `from` is who a rate limit counts an unknown caller by: the rightmost
  `x-forwarded-for` hop no named proxy wrote, walked from the socket out.
  `from(false)` is the socket's address. `from(true)` takes the first hop,
  which a caller writes: kept for 8.x, refused from 9.0.
- A socket is served at `/ws` when the kernel carries one, and every other
  path reaches `api.fetch`.
- `SIGTERM` and `SIGINT` stop once: the second is ignored rather than
  cutting the first short. A stop past `stopTimeoutMs` exits non-zero rather
  than hanging.
- The watch reads listener failures without reading one twice, and says
  nothing at all when nothing broke.

## Refuses

- Nothing. Every refusal belongs to `start`, which ran first.
