# Procedure: testing

Every plugin tests itself, from outside, through its `api.ts`.

## Where

`src/plugins/<name>/tests/`, one file per subject.

A test imports the plugin the way another does, from `../api`, never from
`../internal/`. One needing an internal is testing implementation: either
`api.ts` lacks something, or the test does not belong.

## Shape

Arrange, act, assert, in that order, with a blank line between. Name the case,
not the function. No shared setup hiding a dependency, no helper wrapping the
assertion: a reader sees what is claimed without opening another file.

## The database is real

`startTestKernel({ plugins })` opens an in-memory SQLite, reads the tables and
migrations off the contracts, and starts a kernel with a budget and a dialer
the test reads. Never a stub: a fake accepting what SQLite rejects is where
bugs hide.

Each test builds its own and stops it.

## What must be proved

Every refusal in `usage.md` has a test that triggers it: an untested refusal
is a promise.

Every guard has the attack that motivated it: a body claiming another id, an
output carrying a hash, an error naming a table.

Before fixing a bug, write the test that fails because of it.

## Proving a test

A test that has never failed proves nothing. Break the behaviour, watch it
fail naming the real cause, then put it back.

## What a project checks about itself

`Project.checks()` is the whole self-check: boundaries, wiring, document
length, and every contract key its procedure never names. It finds its own
paths, so a project writes one test and no path into here.

## Refuses

- A test importing another module's `internal/`.
- Shared state between tests, or one depending on order.
- A skipped test left in the tree.
- A refusal in `usage.md` with no test.
