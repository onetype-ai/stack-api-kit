# Procedure: naming

Ours are read twice: by us, and by an application developer reading
autocomplete. A public name is documentation nobody has to open.

## Rule

A name says what the thing **is**, in the plainest word that fits. Not what
happened to it, not the pattern it implements.

A name is a part of speech, not a suffix. Put **the** in front and see if you
get a thing, or **is** and see if you get a state. If the word only fits after
**currently**, it is a verb doing a noun's job: `the encoding` and `is pending`
are names, `currently booting` is not.

```
Registry    not Manager, Store, Holder
Contract    not Config, Meta, Descriptor
Slot        not SlotComponent, SlotWrapper
```

## Types

Nouns, and specific ones: `Plugin`, `Kernel`, `Route`, `Subscription`.

Never `Manager`, `Handler`, `Helper`, `Util`, `Service`, `Data`, `Info`: a
type resisting a concrete noun does more than one thing.

## Functions

Verbs, imperative: `start`, `validate`, `subscribe`, `emit`.

A function returning a value is named for the value, without `get`:
`failures()`, not `getFailures()`. A predicate reads as a question:
`granted()`. A factory is `create<Thing>`, one per capability.

## Variables

The word for what it holds: `plugin`, `route`, `left`. Loop variables take the
singular of what they walk, and stay short only while the whole loop is in
sight.

Never `data`, `res`, `tmp`, `obj`, `val`, `item`, `x`. A variable resisting a
name is holding two things.

## Files

`internal/` files are named for their subject, singular: `registry.ts`,
`socket.ts`. A file holding every type is a file with no subject.

## Refuses

- A pattern name where a concrete noun exists.
- `get` on a reader, `I` on an interface, `Type` on a type.
- `types.ts`, `utils.ts`, `helpers.ts`, `common.ts`.
