# Tenant and exposed registries

A registry is `static` by default: one process's entries. Two options
change where it lives and who reads it.

```ts
registries: { "editor.blocks": { describe, entry: Block, key: "id",
    scope: "tenant", expose: { requires: ["editor.use"] } } },
```

## scope: "tenant"

Entries live in the database, per scope of the owner's `scope` claim.

```ts
await ctx.scopedRegistry("editor.blocks").list();
await ctx.tx((inside) => inside.scopedRegistry("editor.blocks").set(entry));
await ctx.tx((inside) => inside.scopedRegistry("editor.blocks").remove("x"));
```

- The scope is the caller's, never the entry's; `forScope` names one.
- `set` and `remove` only inside `ctx.tx`: the entry, its version and
  the event `<registry>.changed` commit together or not at all.
- `adds` are listed in every scope, and their keys are theirs.
- The event carries op, key, version, scope and permission names, never
  the entry.

## expose

- `GET /registries/<name>` answers `{ version, entries }`: what this
  caller may see, in its scope, at most `cap` (256) entries.
- Channel `registry.<name>` carries each change to sockets in the scope:
  `set` to who may see the entry, `remove` to who could, `skip` to the
  rest, so a key never reaches a socket that may not see it.
- An exposed static registry is what `adds` declare, at version 0: a
  runtime `set` on it is refused, since each process would differ.

## Refuses

- At start: a tenant registry whose owner declares no `scope`, or with
  no store; `expose.requires` naming no permission; a route under
  `/registries/`.
- At run time: a change outside `ctx.tx` (`UNKEPT_ENTRY`), a caller in no
  scope, a key `adds` hold, past `cap` in a scope, and each accessor on
  the other kind of registry, naming the right one.
