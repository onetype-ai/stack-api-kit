# Procedure: testing

Every plugin tests itself, from outside, through its `api.ts`.

## Where

`src/plugins/<name>/tests/`, one file per subject.

A test imports the plugin as another does, from `../api`, never
`../internal/`: one needing an internal tests implementation.

## Shape

Arrange, act, assert, a blank line between. Name the case, not the
function. No shared setup hiding a dependency or helper hiding the claim.

## The database is real

`startTestKernel({ plugins })` opens an in-memory SQLite with the real
migrations, an outbox (unless `outbox: false`), a rate limiter and an
http client the test reads.
A fake accepting what SQLite rejects hides bugs.

`configureTestKernels({ resolve })` in a setup file adds what a plugin
`dependsOn`. Each test builds and stops its own kernel.
`openApi({ plugins, stands, clock, seed })` adds stand-ins by name, a
clock the test moves, and `call(identity, method, path, input)`.

## What must be proved

Every refusal in `usage.md` has a test that triggers it.

Every guard has the attack that motivated it: a body claiming another id,
an output carrying a hash.

Before fixing a bug, write the test that fails on it.

## Proving a test

A test that has never failed proves nothing. Break the behaviour, watch it
fail naming the real cause, then put it back.

## What a project checks about itself

`Project.findAll()` is the whole self-check: boundaries, wiring, document
length, contract keys its procedure never names, and the `required` docs.
`Started` refuses a closed route with no `limit`, unless named `unbounded`.

## Refuses

- A test importing another module's `internal/`.
- Shared state between tests, or one depending on order.
- A skipped test left in the tree.
- A refusal in `usage.md` with no test.
