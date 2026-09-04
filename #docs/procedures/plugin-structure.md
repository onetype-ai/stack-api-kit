# Procedure: plugin structure

One shape, every plugin: someone who has read one knows where to look in all
of them.

## Layout

```
src/plugins/<name>/
    usage.md        contract, <= 1800 characters, required
    api.ts          public surface, the only importable file
    events.ts       events published and consumed
    hooks.ts        hook points offered and claimed
    internal/       private, one file per subject
    tests/
```

`events.ts` and `hooks.ts` are omitted when a plugin has none. Nothing else
lives at the top level.

## Naming

Folder and `name` are the same word: lowercase, no underscores, no `utils` or
`helpers`. A folder that cannot be named in one word is two plugins.

Inside `internal/`, one file per subject: `connect.ts`, `migrate.ts`,
`limit.ts`. Not `manager.ts` or `handler.ts`: those name a pattern, not a
responsibility.

## Files

A file does one thing. When it stops fitting on a screen, the second thing it
grew is a separate file or a separate plugin.

Types at the top, then constants, then functions. One exported thing per
`internal/` file, plus the types it needs.

Comments where a reader would ask why, never what the line does. A comment
restating the code is one more thing to keep true.

## usage.md

Written first, before the API and before any code: it decides the shape. Its
reader is a project developer who will never open `internal/`.

Sections in order: `Description`, `Purpose`, `Usage`, `Refuses`. Technical,
proven, copy-pasteable. What the plugin does, never what it will do.

## Refuses

- A top-level file that is not one of the four named.
- `usage.md` over 1800 characters, or absent.
- A plugin with no `tests/`.
