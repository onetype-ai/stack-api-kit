import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { bothDialects, eachDatabaseItself, freshProcess, notYetOnPostgres, postgresServer, sqliteOnly } from "../../../tools/matrix.mjs";

// what opens a store in a suite: a test kernel, a database, or the matrix's own helper
const REACHES_A_STORE = /startTestKernel\(|\bdatabase\(\s*\{|\bpostgres\(\s*\{|openStore\(|\bdb:\s/u;

function suitesUnder(folder: string): string[]
{
    return readdirSync(folder).flatMap((name) =>
    {
        const path = join(folder, name);

        if (statSync(path).isDirectory())
        {
            return suitesUnder(path);
        }

        return /\/tests\/.*(\.test\.tsx?|\.server\.ts)$/u.test(path) ? [path] : [];
    });
}

const named = [...bothDialects, ...eachDatabaseItself, ...freshProcess, ...postgresServer, ...sqliteOnly, ...notYetOnPostgres];

test("every suite that reaches a store says which databases it runs on, in tools/matrix.mjs", () =>
{
    const unnamed = suitesUnder("src").filter((path) => REACHES_A_STORE.test(readFileSync(path, "utf8")) && !named.includes(path));

    expect(unnamed).toEqual([]);
});

test("the matrix names each suite once, and only suites that exist", () =>
{
    expect(named.filter((path, index) => named.indexOf(path) !== index)).toEqual([]);
    expect(named.filter((path) => !existsSync(path))).toEqual([]);
});

test("a suite on SQLite alone says so in its name, and no other suite registers tests by the dialect", () =>
{
    const conditional = suitesUnder("src").filter((path) => !/\/sqlite-[^/]+$/u.test(path) && /if \(dialect\(\) ===/u.test(readFileSync(path, "utf8")));

    expect(sqliteOnly.filter((path) => !/\/sqlite-[^/]+\.test\.ts$/u.test(path))).toEqual([]);
    expect(conditional).toEqual([]);
});
