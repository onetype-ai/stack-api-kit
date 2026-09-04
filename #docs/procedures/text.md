# Procedure: text

Everything here was measured, not assumed. Text is where a stack quietly
believes the world is English.

## SQLite sorts and folds ASCII only

```
ORDER BY s       Apfel, Ostern, Zebra, Äpfel, Österreich, über
Intl.Collator    Apfel, Äpfel, Ostern, Österreich, über, Zebra
```

`ORDER BY` is code point order, so every accented word lands after `Z`.
`lower('ÄÖÜ')` answers `ÄÖÜ`, and `LIKE '%über%'` misses `Übergrößen`.
`NOCASE` folds A to Z and nothing else, whatever the column holds.

So: sort in JavaScript with `Intl.Collator`, or store a folded column the
service writes and query that. A list ordered in SQL is a list ordered wrongly
for every language but one.

## A character is three different numbers

```
"👨‍👩‍👧‍👦"    length 11, code points 7, bytes 25
"あ"     length 1,  code points 1, bytes 3
```

`z.string().max(200)` counts UTF-16 units and calls them characters, so it
refuses one emoji family at 5 and accepts 200 Japanese characters as 600
bytes. Bound what you actually mean: `Array.from(text).length` for characters
a reader sees, `TextEncoder` for bytes a column holds.

The kit bounds a request body in bytes, because that is what arrives.

## Normalisation

`é` is one code point or two, and the two compare unequal. Normalise where
text enters — `raw.normalize("NFC")` — or one caller writes a slug another
cannot find.

## Errors speak one language

A schema's message is English, and the kit has no locale of its own. A caller
who needs otherwise gets a `code` from a `Refusal` and translates it; the
message is for whoever reads the log.

## Refuses

- Ordering or case-folding non-ASCII text in SQL.
- `.max()` on a length that means characters or bytes.
- Comparing text that entered unnormalised.
