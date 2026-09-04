# kernel

## Description

The plugin runtime an API builds on: registry, validation, routes, events,
hooks, permissions.

## Purpose

A server grows into one thing unless something holds the seams. A plugin
declares what crosses; the kernel refuses the rest, and knows no auth model.

## Usage

```ts
export default definePlugin.over<Rows, Services>()("items", {
    version: "1.0.0",
    describe: "Owns items.",
    tables: { items },
    services: (ctx) => ({ items: new ItemsService(ctx) }),
    routes: itemRoutes,
});

const route = defineRoute<Ctx>();

export const itemRoutes: readonly Endpoint<Ctx>[] = [
    route({
        method: "GET",
        path: "/items",
        describe: "Lists what the caller sees.",
        requires: ["items.read"],
        input: ListQuery.schema,
        output: ItemPage.schema,
        handle: (input, ctx) => ctx.services.items.list(input),
    }),
];
```

`over` names what `ctx.db` and `ctx.services` are; `defineRoute` is what makes
a handler read what its own schema parsed rather than `unknown`.

`input` is body, query and path; `reads` the headers. `output` is a whitelist,
and one that cannot strip is refused at startup. An `Answered` sets the status
and headers. A route is closed until `public`; a `limit` needs a `budget`.

Listening is not depending: a listener names none, because an emitter does not
know who hears it.

## Refuses

At startup: a duplicate plugin, an unknown or cyclic dependency, a name
outside its namespace, a duplicate route, event, hook, command or permission,
a reference to something undeclared, a bad path, an unfilterable output, a
limit with no budget, a credential header.

At runtime: an undeclared event, a bad payload, a route or command without its
permission, a caller past a budget, an undeclared host.
