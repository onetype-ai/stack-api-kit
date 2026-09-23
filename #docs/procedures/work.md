# Procedure: work

Events kept until heard, commands run later: both at least once.

## An event

```ts
await ctx.tx(async (inside) =>
{
    await inside.db.insert(items).values({ ...row, ...inside.stamped("items") });
    inside.events.emit("items.item.created", { id: row.id });
});
```

With `start({ outbox: true })` the event is written in the transaction and
delivered after the commit. A listener that throws is retried with
backoff, and only the listeners that have not heard it are called again.
After `mostAttempts` (8) it waits as a dead letter. Emitting outside `tx`
is refused while an outbox is on; give a test kernel `outbox: true` to
prove it.

A listener recognises what it already did: it may hear an event twice.

## A command later

```ts
commands: { "items.archive": { describe: "Archives one.", schema: Id, run: archive } },

ctx.commands.later("items.archive", { id }, 3600);
```

A claim is a lease, renewed while the command runs; one whose process died
is taken again and counted. `schedule: true` runs what is due in this
process, `"enqueue"` only stores it for one that does. A command that
refuses 4xx is not tried again.

## What stays written

An event payload, a command input and every `Stored.define(name, schema)`
are read long after they were written: a project test runs
`StoredContracts.checkFile(lock, plugins)`, and a new required field, a
removed one or a narrower type fails until `accept` names why.

## Watching it

One plugin declaring `watchesWork: true` reads `ctx.work`: counts, failed
jobs and dead letters, never an input or a payload, and `retryFailed(id)`.
Guard what it answers to operators.

## Refuses

- `ctx.emit` outside `tx` with an outbox on; `later` for another's command.
- `ctx.work` for a plugin that did not declare it.
