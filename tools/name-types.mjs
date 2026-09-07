#!/usr/bin/env node
//
// Gives the shared declaration chunk a name somebody can find.
//
// tsup names it by content hash, so the one file worth opening when
// reference.md is not enough — every signature the kit exports — cannot be
// reached by name, and changes on every build. Renamed to types.d.ts, with
// both entries pointed at it.
//

import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = "dist";
const hashed = (await readdir(dist)).filter((name) => /^api-.*\.d\.ts$/.test(name));

if (hashed.length === 0)
{
    process.exit(0);
}

for (const name of hashed)
{
    await rename(join(dist, name), join(dist, "types.d.ts"));

    const was = `./${name.replace(/\.d\.ts$/, ".js")}`;

    for (const entry of ["index.d.ts", "testing.d.ts"])
    {
        const at = join(dist, entry);
        const source = await readFile(at, "utf8");

        await writeFile(at, source.replaceAll(was, "./types.js"));
    }
}

console.log(`named ${hashed.join(", ")} as types.d.ts`);
