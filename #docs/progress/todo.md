# todo

Ordered by what blocks the most.

## An attacker

Seven systems were built on this and every one shipped green. All seven
authors were builders: nobody has tried to break what they made. That is the
one kind of test never run, and it is the one that decides whether "closed by
default" holds under somebody trying.

## Postgres

`start` already takes a store, so this is a plugin nobody has written. It
answers the two costs SQLite imposes: one writer for the whole process, and
ordering that has to happen in a service because SQL sorts by code point.

Until it exists, one process holds one database, which is fine for an isolated
environment and not for anything sharing one.

## A limiter more than one process can share

The budget lives in memory, so two processes are two allowances. Fine while
one process is the deployment; wrong the moment it is not.

## Known and deliberate

- **Table isolation is the compiler's, not the database's.** A plugin
  importing another's table object reaches its rows. A connection per plugin
  would make a transaction across two impossible, which costs more than it
  buys.
- **Writes are serialised.** One SQLite connection takes one writer, and a
  transaction belongs to the connection rather than to the call that opened
  it. That queue is what makes `tx` mean what it says, and also what makes a
  slow transaction delay every write behind it.
- **A hook cannot answer data.** It is a veto, and widening it would make a
  participant a dependency without saying so.
- **Error messages are English.** The kit has no locale; whoever needs another
  translates a `Refusal` by its `code`.
