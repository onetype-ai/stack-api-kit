# serve

## Description

Putting a started kernel on a port, and taking it off one cleanly.

## Purpose

`start()` answers a kernel. Reaching it over the network is the rest: a
socket, a signal that means stop, a watch on failed listeners. A stop
written wrong loses the requests in flight.

## Usage

```ts
import { Server } from "@onetype/stack-api-kit";

const api = await start({ ... });

await Server.open(api, { port: 7280, log, watchSeconds: 60 });
```

`Server.open` listens, installs the signal handlers and starts the watch.

```ts
http: { from: Server.from({ trustedProxies: ["10.0.0.0/8"] }) }
Server.listen(api, port)     // the socket alone, for a caller doing its own
```

- `from` is who a rate limit counts an unknown caller by: the rightmost
  `x-forwarded-for` hop no named proxy wrote, walked from the socket out.
  `from(false)` is the socket's address. `from(true)` takes the first hop,
  which a caller writes: kept for 8.x, refused from 9.0.
- `/ws`, when the kernel carries sockets, is identified on upgrade as an
  HTTP request is; a session cookie from an origin not allowed closes 4003.
  It sends `$ready`, acks each subscribe (or CHANNEL_REFUSED), pings `$ping`,
  re-identifies every 30 s (4001), lives 15 min (4000), caps frames at
  `bodyBytes` (1009), sends `$backoff` then 1013 past a caller's limit, and
  closes 1012 on stop.
- `SIGTERM` and `SIGINT` stop once: the second is ignored rather than
  cutting the first short. A stop past `stopTimeoutMs` exits non-zero rather
  than hanging.
- The watch reads listener failures without reading one twice, and says
  nothing at all when nothing broke.

## Refuses

- Nothing. Every refusal belongs to `start`, which ran first.
