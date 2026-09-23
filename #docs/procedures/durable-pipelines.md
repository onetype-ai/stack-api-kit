# Durable pipelines

`flavour: "durable"` runs each step as scheduled work, stores what it
answers, and resumes after a crash at the first step with nothing stored.

```ts
pipelines: { "posts.publish": { describe, input: Draft, output: Post,
    flavour: "durable",
    steps: [{ id: "render", result: Rendered, run }, { id: "store", result: Post, run }] } },

const { runId } = await ctx.tx((inside) =>
    inside.pipeline("posts.publish").run(draft, { key: draft.id }));
await ctx.pipeline("posts.publish").status(runId);   // { status, step?, output? }
await ctx.tx((inside) => inside.pipeline("posts.publish").retry(runId));
```

- `run` and `retry` only inside `ctx.tx`: the run commits with the work
  that asked. A second `run` with its `key` in the scope answers the first.
- A step is `run(state, ctx, { stop, idempotencyKey })`, acting in the
  run's scope for nobody. Pass `idempotencyKey` (`<runId>:<step>`, the
  same on every attempt) to a provider, so a retry never charges twice.
- A step's answer is checked against `result` and stored with the next
  step's job in one transaction. A crash mid-step runs it again, so steps
  are idempotent.
- A step that throws is tried again on the schedule's backoff; past its
  `retries` (3) the run is `failed` at it, and `<pipeline>.failed`
  `{ runId, step, scope, reason }` is emitted, without the fault's text.
- `status` and `retry` answer nothing for another scope's run.
- A step's job the schedule gives up on fails the run too, reason
  `abandoned`: no run waits for a job that never comes.

## Refuses

- At start: a durable step with no `result`, and a durable pipeline with
  no store or schedule.
- At run time: `run` or `retry` outside `ctx.tx` (`UNKEPT_JOB`), input
  its schema refuses, and `status` on a request pipeline.
