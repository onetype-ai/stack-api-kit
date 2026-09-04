# done

Every item below was broken on purpose after it was fixed, watched to fail,
and put back. Five audits found what is listed under "found and fixed"; each
was reproduced locally before anything changed.

## The kernel

- The contract an API declares: routes with a method, input and output schema,
  tables, migrations, budgets, outbound hosts.
- Request order: signed in, within budget, permitted, parsed, run, filtered.
- Errors: a `Refusal` reaches the caller, everything else answers 500 with one
  sentence and is logged in full, read off the Error rather than passed whole.
- Services are built per caller. One built at startup answered every request
  as nobody.

## Found and fixed

- **`tx` was not concurrency-safe.** One connection, an async transaction, and
  any await: another request's write joined that transaction and vanished with
  its rollback, having reported success. Transactions and writes are now
  serialised; an inner one is a savepoint.
- **`output` was not a whitelist.** `z.any()`, a loose object, a record and a
  transform all forwarded whatever the handler returned, password hash
  included. A schema that cannot strip is now refused at startup.
- **`Route.limit` enforced nothing.** Declared, typed, surfaced on the public
  API, given a 429 path, adopted on real routes, inert. The `guard` limiter it
  needed was an orphan in the same package. Both are wired, and a limit with
  no budget refuses to start.
- **Events escaped transactions.** Emitting on the outer `ctx` inside a `tx`
  delivered at once. Held against whichever transaction is open now.
- **Query parameters were unusable.** Every one arrived as an array, so
  `z.string()` could never match `?q=hello`.
- **The wiring check certified.** It counted comments and test fixtures as
  reads, which is how `Route.limit` passed it. Both are excluded now.
- Body limits skipped DELETE, preflights were approved for routes that do not
  exist, and `Vary: Origin` was absent whenever an origin was refused.

## Found by proving what was unproven

- **Savepoints collided under load.** The name came from a shared depth
  counter, and a transaction parked on a network call let the next one read
  that counter, believe itself nested, and open a savepoint inside a
  stranger's transaction. Four requests in forty answered 500 for a savepoint
  that was never theirs. Depth is now read from the call stack, and a
  savepoint carries its own name.

  Found only by a transaction holding a real `await` on the network. Every
  earlier load test passed with the queue removed, which means they proved
  nothing: SQLite's own calls are synchronous, so nothing interleaved.

## Found by building on it, seven times

Seven systems were built by agents with no memory of each other, each reading
only the documents. Every one shipped green, and each found something:

- **`ctx.caller` was present in a listener** and absent after a restart, so
  code that worked in process broke on the first redelivery.
- **`scope` guarded reads and not writes.** A caller in one tenant wrote a row
  stamped with another's. `stamped` exists because of that.
- **A listener had no way to narrow**, so plugins grew a second unscoped path.
  `forScope` closed it.
- **The unread-field check weakened with every plugin**, because it searched
  all of them rather than the one declaring the type.
- **A three-deep dependency chain could not boot** in an honest test.
- **An event whose payload failed validation answered 400**, blaming the
  caller's body for the emitter's mistake.
- **Every stranger shared one rate-limit counter**, so one guesser locked
  sign-in for everybody. The root now counts by caller.
- **A failed listener was silent.** Nothing waits on one, so its failure
  reached nobody. The root now watches and warns once each.
- **`text.md` taught the wrong count.** It named `Array.from` for characters a
  reader sees, which returns 7 for the emoji family in its own example. Three
  builds independently wrote `Intl.Segmenter` instead.

## Removed

`boot`, `Host`, `offer`/`take` and the six plugin factories. The composition
their documentation described had never run and could not: `httpPlugin` needed
a started kernel, and `kernelPlugin` offered a factory. `mount` does the work.
