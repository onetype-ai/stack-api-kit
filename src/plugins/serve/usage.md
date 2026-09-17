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
Server.from(behindProxy)     // who a rate limit counts an unknown caller by
Server.listen(api, port)     // the socket alone, for a caller doing its own
```

- `from` reads `x-forwarded-for` only where a proxy is known to set it, and
  takes the first of the chain, which is the client the proxy saw. Absent or
  blank counts as `"anonymous"`, one shared stranger.
- Trusting that header with nothing in front of the process lets a caller
  write their own address, so `behindProxy` is a claim about deployment, not
  a convenience.
- A socket is served at `/ws` when the kernel carries one, and every other
  path reaches `api.fetch`.
- `SIGTERM` and `SIGINT` stop once: the second is ignored rather than
  cutting the first short. A stop past `stopTimeoutMs` exits non-zero rather
  than hanging.
- The watch reads listener failures without reading one twice, and says
  nothing at all when nothing broke.

## Refuses

- Nothing. Every refusal belongs to `start`, which ran first.
