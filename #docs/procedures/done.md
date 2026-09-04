# Procedure: done

A capability is done when all five hold, not when it compiles. Every one was
learned from a build that shipped without it.

## 1. The document is true today

`usage.md` describes what the code does now, never what it will do. Every
claim in it is a claim someone will rely on.

## 2. Every guarantee was watched to fail

Break the code on purpose, see the test fail, put it back. A test never seen
red proves the test runs, not that the code works.

This caught tautological assertions twice in the previous build, including one
written minutes earlier.

## 3. Nothing declared is unreachable

For every field in a contract, find the code that reads it. If nothing does,
the field does not exist — and it is worse than missing, because the document
promises it works.

`Route.limit` was declared, typed, surfaced on the public API and given a 429
path, and enforced nothing. The wiring check passed it because a name in a
comment counted as a read.

## 4. It ran where it will really run

A green suite is not a server. Start one, send a real request, and read the
log. A test runner cannot see a header that never reaches the wire, a
migration that never ran, or a startup refusal nobody can read.

## 5. Every check is as strong as its rule

Violate the rule on purpose and confirm the check names the violation. A check
that passes on a deliberate breach is worse than none: it certifies.

Parse what the code actually does, never what it declares. Cycle detection over
a declared list catches metadata; the real cycle is in the imports.

## Refuses

- A claim in `usage.md` no code supports.
- A test never watched to fail.
- A declared field nothing reads.
- A check never proved against a deliberate violation.
- "Done" on something that has only ever run in a test runner.
