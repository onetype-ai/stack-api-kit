# Procedure: error handling

Two audiences that never see the same thing. A caller learns what they can
fix; we learn everything else.

## What a caller sees

A code, a sentence, and field errors when an input schema named them. Nothing
more, ever.

`Refusal` is the one way to answer a caller deliberately:

```ts
throw new Refusal(409, "ITEM_LOCKED", "That item is being edited.");
```

Anything else thrown answers 500 with one fixed sentence, whatever it was. A
stack, a path, a SQL fragment, a column, a driver message, a config value:
each is something an attacker learns from and no caller needs.

A 404 reads the same whether the route is missing or the caller may not see
it. Telling them apart is telling someone what exists.

## What we see

Every 5xx is logged in full, with the request id, the plugin, the message and
the stack. A 4xx is not: it was already explained to whoever caused it.

Read an `Error` apart before writing it down: `JSON.stringify` of one gives
`{}`, so a log holding it says a request failed and nothing about why.

Wrap a cause, never replace it: `cause` must survive to the top.

## Error classes

One class per subject, carrying a `code` that is a closed union: a caller
branches on it, and a new member is a compile error wherever it is handled
exhaustively. `KernelFault`, `MigrationFault`, `OutboundFault`. Never a bare
`Error`, a string, or an object literal.

## Where we throw

Validation throws: a contract that does not hold is a programming error, and
must be loud, at startup.

A listener that fails is caught, logged and recorded: one plugin's bug is not
another's failed request.

## Refuses

- Anything but a package error class, thrown across a boundary.
- An internal detail in a message a caller can read.
- A failure with nowhere to read it.
