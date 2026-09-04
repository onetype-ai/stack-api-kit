# Procedure: validation

Everything crossing in is checked where it enters. We are the server: what
arrives was written by someone we cannot see, and some of them are hostile.

## Three inputs

The **project** sends plugins, options and config: wrong, never hostile. It
gets a thrown error naming its mistake, at startup, before anything runs.

The **caller** sends requests: untrusted, and the reason the rest exists. A
request is parsed by the route's input schema and refused with a 400 naming
the fields.

Another **server** answers our outbound calls: untrusted too. A partner API is
one breach from being an attacker, and one deploy from changing shape.

## The project

Validated once, at `start`. Everything, then a report: four mistakes should
take one run to learn, not four.

`start` brings up every plugin or throws. Nothing partially starts.

Check what the type system cannot: names against a pattern, references against
what exists, cycles, duplicates. TypeScript is erased at runtime.

## The caller

Parse at the boundary, never cast. `as` is a lie told to the compiler, and a
body that changed shape becomes `undefined` three files later.

Bound anything the other side controls: body, page, string and array length. A
schema with no maximum accepts a megabyte.

Coerce in the schema, never before it. A converter ahead of it decides what
`""` or `"0x10"` mean before the field that owns them gets a say.

## Going out

An output schema is a whitelist, not a check: what it does not name does not
leave.

## Refuses

- `as` on anything that crossed a boundary, or `any` where `unknown` fits.
- Validating at use rather than at entry.
- Stopping at the first failure when the rest could be reported too.
- A limit the other side sets.
