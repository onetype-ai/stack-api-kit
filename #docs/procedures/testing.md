# Procedure: testing

Every plugin tests itself, from outside, through its `api.ts`.

## Where

`src/plugins/<name>/tests/`, one file per subject.

A test imports the plugin as another does, from `../api`, never
`../internal/`: one needing an internal tests implementation.

## Shape

Arrange, act, assert, a blank line between. Name the case,
not the function. No shared setup hiding a dependency, no helper wrapping the
assertion: a reader sees what is claimed without opening another file.

## The database is real

`startTestKernel({ plugins })` opens an in-memory SQLite with the real
migrations, a rate limiter and an http client the test reads; pass
`outbox: true` to test as a deployment with an outbox runs.
A fake accepting what SQLite rejects is where bugs hide.

`configureTestKernels({ resolve })` in a setup file adds what a plugin
`dependsOn`, so a test names only the plugin it proves. Each test builds
its own kernel and stops it. `testClock()` gives `now` a test moves by hand.

## What must be proved

Every refusal in `usage.md` has a test that triggers it: an untested refusal
is a promise.

Every guard has the attack that motivated it: a body claiming another id,
an output carrying a hash.

Before fixing a bug, write the test that fails because of it.

## Proving a test

A test that has never failed proves nothing. Break the behaviour, watch it
fail naming the real cause, then put it back.

## What a project checks about itself

`Project.findAll()` is the whole self-check: boundaries, wiring, document
length, and every contract key its procedure never names.

## Refuses

- A test importing another module's `internal/`.
- Shared state between tests, or one depending on order.
- A skipped test left in the tree.
- A refusal in `usage.md` with no test.
