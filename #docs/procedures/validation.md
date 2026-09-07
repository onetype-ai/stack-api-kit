# Procedure: validation

Everything crossing in is checked where it enters: what arrives was written
by someone we cannot see, and some of them are hostile.

## Three inputs

The **project** sends plugins, options and config: wrong, never hostile, and
told at startup before anything runs.

The **caller** sends requests: untrusted, and the reason the rest exists. One
is parsed by the route's input schema and refused with a 400 naming fields.

Another **server** answers our outbound calls: untrusted too. A partner is one
breach from being an attacker, one deploy from changing shape.

## The project

Validated once, at `start`. Everything, then a report: four mistakes should
take one run to learn. `start` brings up every plugin or throws, so nothing
partially starts.

Check what types cannot: names, references, cycles, duplicates. TypeScript is erased at runtime.

## The caller

Parse at the boundary, never cast: `as` is a lie told to the compiler, and a
body that changed shape becomes `undefined` three files on.

Bound what the other side controls: body, page, string and array length. A
schema with no maximum accepts a megabyte.

Coerce in the schema, never before it: a converter ahead of it decides what
`""` or `"0x10"` mean before the field that owns them gets a say.

## Going out

An output schema is a whitelist: what it does not name does not leave. One
that cannot strip is refused at startup, naming the route — `z.any`,
`z.unknown`, `z.record`, a loose object, a catchall and a transform each
forward what the handler returned.

## Refuses

- `as` on anything that crossed a boundary, or `any` where `unknown` fits.
- Validating at use rather than at entry.
- Stopping at the first failure when the rest could be reported.
- A limit the other side sets.
