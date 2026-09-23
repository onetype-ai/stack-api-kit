# Registries and pipelines

The same contract as the app kit.

A **registry** is a named list one plugin declares and its dependants fill.

```ts
registries: { "editor.blocks": { describe, entry: Block, key: "id",
    cap: 64, reserved: ["core"], replace: "refuse", set: "dependants" } },
adds: { "editor.blocks": [{ id: "quote", order: 20 }] },
const stop = ctx.registry("editor.blocks").set(entry);
ctx.registry("editor.blocks").list();
```

- `adds` and `set` get the same checks: schema, key, reserved, cap.
- Entries list by `order`, then key, minus what the caller lacks the
  `requires` for.
- A runtime `set` is per process, like presence.

A **pipeline** is ordered steps; dependants add steps beside an anchor.

```ts
pipelines: { "posts.publish": { describe, input: Draft, output: Post,
    steps: [{ id: "validate", run }, { id: "store", run }] } },
adds: { "posts.publish": [{ id: "moderate", after: "validate", run }] },
await ctx.pipeline("posts.publish").run(draft);
```

- A step is `run(state, ctx, { stop })`. It answers the next state, or
  `stop(output)` to end the run early. Each step gets its plugin's
  context, for the same caller.
- Input and output are checked. `kernel.explain(name)` answers the
  order; start logs it, and each step logs its outcome, never the state.
- **No transaction.** A step that writes opens its own `ctx.tx`. A step
  calling a provider never writes in the same one: it would hold locks.

## Refuses

- At start, all at once:
  - an undeclared name, or an addition from a non-dependant;
  - a bad entry; a step with no anchor, an unknown one, or a taken id;
  - an anchor cycle.
- At run time: a bad `set`, a refused input or output, and a failing
  step (`PIPELINE_FAILED`, naming it; the caller sees a neutral 500).
