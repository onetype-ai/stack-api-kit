# kernel

## Description

The plugin runtime: checks, routes, events, hooks, identity.

## Purpose

A plugin declares what crosses its seams; the rest is refused.

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

`over` types `ctx.db` and `ctx.services`. `input` is body, query and path;
`reads` names headers a handler sees, `sends` ones it may set. `output` is a
whitelist; `streams`, `document`, `file`: `procedures/answers.md`. A route is
closed until `public`; `limit` needs a `rateLimiter`.

Who is calling, and what that means, are one plugin each:

```ts
identifies: (ctx, request) => Sessions.of(ctx, request.headers.get("cookie")),
grants: (ctx, who) => Roles.of(ctx, who.id),
```

`ctx.push` reaches as far as the channel's `reach`: `viewer`, `scope`, one
`identity` (`{ to }`) in the scope, or `everyone`; `ctx.presence` says who
is connected. Work, outbox: `procedures/work.md`; registries and
pipelines: `procedures/registries-and-pipelines.md`.

## Refuses

At startup: anything declared twice, outside its namespace, or referenced
and undeclared; a cycle; a bad registry entry or step; an unreachable
route, or one answering two ways; a `limit` without `rateLimiter`;
reading a credential or sending a kit header.

At runtime: an undeclared event or host, a bad payload, a missing
permission, a caller past budget, `ctx.work` without `watchesWork`, each
naming the plugin and the fix.
