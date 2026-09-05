# Procedure: security

The server is where a refusal counts. A client checks to be helpful; we check
because nothing else will.

## What the kit holds

Mechanical, so no plugin forgets:

- **Input** is a schema on every route. A handler never sees what failed.
- **Output** is a whitelist, and one that cannot strip is refused at startup
  rather than trusted per request.
- **Errors** never cross as they are: a `Refusal` speaks to a caller, and
  anything else answers 500 with one sentence.
- **Routes are closed** until `public: true`. Not deciding fails shut.
- **Credentials never reach a handler.** A route reading `cookie` or
  `authorization` is refused at startup, so no log of its input holds one.
- **Outbound** reaches declared origins only, and never follows a redirect:
  the kernel checked the first url and never sees the second.
- **Bodies** are bounded before parsing; secrets compared in constant time.
- **Writes** are serialised, so one request's query cannot land inside
  another's transaction.

## What you hold

The kit cannot know your domain:

- **Ownership is a query, not a permission.** `items.read` says the caller may
  read items, never that *this* one is theirs. The kernel carries your tenant
  in `claims` and will not guess what it means. Scope the read.
- **A route without a `limit` has none.** Nothing enforces what nothing
  declared, and an unlimited read is how one guessed id becomes the table.
- **Refuse with a `Refusal`.** A bare `Error` in a validation path answers 500
  and pages someone at night over a bad title.
- **Another server's answer is input.** Parse it like a caller's.

## Proving it

Write the attack before the guard: a body claiming another id, an output
carrying a hash, an error naming a table. Watch it succeed, then stop it.
