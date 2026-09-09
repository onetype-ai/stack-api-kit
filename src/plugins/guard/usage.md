# guard

## Description

Rate limiting per caller, and comparing a secret without leaking how much of
it was right.

## Purpose

Two things every server needs and neither belongs in a plugin: a plugin that
could turn off its own limit is not a limit, and a secret compared with `===`
tells an attacker, in how long it took, how many characters were correct.

## Usage

```ts
const limit = limiter();

const verdict = limit.spend(`${identity.id}:${route.path}`, { requests: 60, seconds: 60 });

if (!verdict.allowed)
{
    return refused(429, verdict.resetsIn);
}
```

```ts
if (!equalsInConstantTime(sent, expected))
{
    return undefined;
}
```

- `spend` counts one request against a fixed window and answers whether it is
  allowed, what is left, and when the window resets.
- `refund` gives one back, never below zero. A route declaring
  `limit: { countSuccess: false }` counts only the calls that did not succeed:
  five wrong passwords is an attack, five right ones is somebody with five
  devices. Leave it out where the successful call is the expensive one.
- A window holds one counter per key rather than one entry per request, so a
  flood costs no memory in proportion to itself.
- `sweep` drops windows that have passed; the plugin runs it on a timer.
- `unlimited()` is the same shape and counts nothing, which is what
  `start({ limits: false })` runs on, saying so loudly at boot.
- `equalsInConstantTime` compares in constant time and answers false on a length difference
  rather than throwing.

## Refuses

Nothing. Both answer rather than throw: a limiter that threw would make every
caller's route handler carry a try, and a comparison that threw would say, by
throwing, that the lengths differed.
