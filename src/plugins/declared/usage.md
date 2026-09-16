# declared

## Description

What every plugin declares, read back as data.

## Purpose

A plugin's contract is spread across its definition: routes here, events there,
commands somewhere else. Reading it means opening the file. This hands back the
whole surface as one shape, so a person or an agent sees what a plugin offers
without reading its source.

## Usage

```ts
import { declarationsOf } from "@onetype/stack-api-kit";

const all = declarationsOf(plugins);
const one = declarationsOf(plugins, "shop");

// or from a started kernel, in dependency order
kernel.declarations();
kernel.declarations("shop");
```

- `declarationsOf` is pure: it reads the definitions it is handed and starts
  nothing. It works before `start()`, with no database and no config.
- `kernel.declarations()` answers the same shape for what actually started,
  in the order the kernel resolved. It refuses before `start()`.
- A name that no plugin carries answers an empty list rather than throwing,
  because asking about a plugin that is not there is a question, not a fault.
- Every list is sorted by name, so two runs of the same plugins agree.
- Routes carry `public` and `limit` as declared: a route that never named
  either reads as `public: false` and no limit, which is how the kernel
  treats it.
- Schemas are not included. What a route accepts is its own contract, and a
  half-rendered schema reads as authority it has not earned.

## Refuses

- `kernel.declarations()` before the kernel started, naming that rather than
  answering an empty list that would read as "this plugin declares nothing".
