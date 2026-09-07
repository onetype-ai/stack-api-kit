# kernel

## Description

The plugin runtime an API builds on: registry, checks, routes, events,
hooks, identity.

## Purpose

A server grows into one thing unless something holds the seams: a plugin
declares what crosses, the rest is refused.

## Usage

```ts
export default definePlugin.over<Rows, Services>()("items", {
    version: "1.0.0", describe: "Items.", tables: { items },
    services: (ctx) => ({ items: new Items(ctx) }),
    routes: [defineRoute<Ctx>()({
        method: "GET", path: "/items", describe: "Lists.",
        requires: ["items.read"], input: Query.schema, output: Page.schema,
        handle: (asked, ctx) => ctx.services.items.list(asked),
    })],
});
```

`over` names what `ctx.db` and `ctx.services` are. `input` is body, query and
path, plus files where `accepts: "form"`; `reads` the headers. `output` is a
whitelist. A route is closed until `public`; `limit` needs a budget.

One plugin says who is calling, one what it means:

```ts
identifies: (ctx, request) => Sessions.of(ctx, request.headers.get("cookie")),
grants: (ctx, who) => Roles.of(ctx, who.id),
```

`identifies` names no permission: `grants` fills them, so none grants itself.
`mayGrant` grants nothing: it is what startup reads to refuse a route nobody
could reach. Without one, any declared permission passes.

`measure("bytes")` marks a number with what it counts: bytes where gigabytes
were wanted does not compile.

## Refuses

At startup: anything declared twice, named outside its own namespace, or
referenced that nobody declared; a cycle; a route nobody can reach; a closed
route with no budget; a handler reading a credential header.

At runtime: an undeclared event or host, a bad payload, a missing permission,
a caller past budget. Every refusal names the plugin and the fix.
