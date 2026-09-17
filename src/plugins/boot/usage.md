# boot

## Description

Reading configuration and writing logs, before a kernel exists.

## Purpose

A composition root needs both before `start()`: a port parsed, an origin list
read, a logger to hand the kernel. Every project wrote these itself, each one
slightly differently.

`Env` refuses rather than repairs, and names the variable when it does.
`Log` writes one JSON object a line, and never throws while writing one.

## Usage

```ts
import { Env, Log } from "@onetype/stack-api-kit";

const port = Env.number("PORT", 7280, 1, 65_535);
const origins = Env.list("ORIGINS");
const level = Env.oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"], "info");

const log = Log.forLevel(level);
```

`Env` reads `process.env`. Where a value comes from somewhere else — a bundler
replacing `import.meta.env` — read it there and pass it to the rule:

```ts
Env.rules.number("PORT", import.meta.env.PORT, 7280, 1, 65_535);
```

- Set and empty throws; unset takes the fallback. "Absent" and "blank" are
  never the same answer.
- `number` takes whole numbers in range: `"1.5"`, `"-1"`, `"abc"` and `" "`
  are each refused by name.
- `flag` takes `"true"` or `"false"`, so `"1"` and `"yes"` are refused rather
  than guessed at.
- `list` splits on commas, trims, and drops what a trailing comma leaves.
- `Log.line` keeps its own `at`, `level` and `line` whatever a caller passes
  under those names. An `Error` becomes `{ message, stack }`, a bigint a
  string, and what it cannot read at all becomes `"unreadable"`.

## Refuses

- Every `Env` rule throws naming the variable, what was expected and what
  arrived. Nothing is coerced or silently defaulted.
- `Log.forLevel` given a level it does not know still answers a logger, so a
  bad `LOG_LEVEL` never silences the process.
