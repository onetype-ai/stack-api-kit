#!/usr/bin/env node
//
// The package's exported surface, written out as a flat list of signatures.
//
// Generated from the built .d.ts rather than the source, so what it shows is
// what a consumer actually receives. Hand-written before, it drifted: it still
// named `listenTo`, `resetsIn` and `UNHEARD_EVENT` months after those were
// renamed. Run it from the package root, after a build.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "schema.md";

function entryPoints()
{
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const entries = [];

    for (const [path, target] of Object.entries(manifest.exports ?? {}))
    {
        const types = typeof target === "string" ? null : target.types ?? target.import?.types ?? null;

        if (types !== null && existsSync(types))
        {
            entries.push({
                name: path === "." ? manifest.name : `${manifest.name}/${path.replace("./", "")}`,
                file: types,
            });
        }
    }

    return entries;
}

// A declaration runs from its keyword to the line that closes it. Walked with
// a brace counter rather than matched: a body holds its own braces, and an
// expression that stops at the first closing one cuts every interface in half.
function declarations(lines)
{
    const head = /^(?:export\s+)?declare\s+(function|class|const)\s+([\w$]+)|^(?:export\s+)?(interface|type)\s+([\w$]+)/;
    const declared = [];

    for (let at = 0; at < lines.length; at++)
    {
        const start = head.exec(lines[at]);

        if (start === null)
        {
            continue;
        }

        let depth = 0;
        let opened = false;
        let end = at;

        for (let line = at; line < lines.length; line++)
        {
            for (const character of lines[line])
            {
                if (character === "{")
                {
                    depth++;
                    opened = true;
                }
                else if (character === "}")
                {
                    depth--;
                }
            }

            end = line;

            if (opened && depth === 0)
            {
                break;
            }

            if (!opened && /;\s*$/.test(lines[line]))
            {
                break;
            }
        }

        // The block above a declaration describes it. Walked backwards so the
        // sentence travels with the name it belongs to.
        const comment = [];

        for (let above = at - 1; above >= 0; above--)
        {
            const line = lines[above].trim();

            if (line === "*/" || line === "/**" || line.startsWith("*") || line.startsWith("/**"))
            {
                const text = line.replace(/^\/\*\*\s?/, "").replace(/\s*\*\/$/, "").replace(/^\*\s?/, "").trim();

                if (text !== "")
                {
                    comment.unshift(text);
                }

                continue;
            }

            break;
        }

        declared.push({
            kind: start[1] ?? start[3],
            name: start[2] ?? start[4],
            comment,
            body: lines.slice(at, end + 1),
        });

        at = end;
    }

    return declared;
}

// One `local as public` pair from an export list. `type` is a modifier on the
// clause, not part of either name.
function renames(list)
{
    const pairs = [];

    for (const part of list.split(","))
    {
        const cleaned = part.replace(/\btype\b/, "").trim();

        if (cleaned === "")
        {
            continue;
        }

        const [local, shown] = cleaned.split(/\s+as\s+/);

        pairs.push({ local: local.trim(), shown: (shown ?? local).trim() });
    }

    return pairs;
}

// Only what the entry re-exports, and only under the name it re-exports it by:
// a .d.ts carries every type it needed on the way, and a consumer cannot name
// the ones the entry does not list.
//
// Anchored at column 0 so a namespace's own `export { ... }` — indented inside
// `declare namespace api$2 { ... }` — is not read as a module export. Reading
// those put `from$1`, `NAME$2` and the rest of the namespace internals in the
// file as if they were importable; they are neither importable nor nameable,
// and a reader who copied one got a SyntaxError.
function exported(source, chunkSourcesByFile)
{
    // A chunk shortens its declarations on the way out — `KernelOptions as a` —
    // and the entry lengthens them back — `a as KernelOptions`. The short names
    // restart at `a` in every chunk, so the hop is resolved against the one
    // chunk the clause names: a single shared table let one chunk's `a` bury
    // another's, and the buried declarations vanished from the file.
    const declaredAsByFile = new Map();

    for (const [file, chunk] of chunkSourcesByFile)
    {
        const declaredAs = new Map();

        // `export type { ... }` as well as `export { ... }`: a chunk of nothing
        // but types uses the first spelling, and skipping it lost all of them.
        for (const block of chunk.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm))
        {
            for (const { local, shown } of renames(block[1]))
            {
                declaredAs.set(shown, local);
            }
        }

        declaredAsByFile.set(file, declaredAs);
    }

    const shownBy = new Map();

    for (const block of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s+["']([^"']+)["'])?/gm))
    {
        // Only a clause with a `from` came through a chunk; a bare list names
        // declarations sitting in the entry itself.
        const from = block[2] ?? null;
        const file = from === null ? null : [...declaredAsByFile.keys()].find((path) => path.endsWith(from.replace(/\.js$/, ".d.ts").replace(/^\.\//, "/")));
        const declaredAs = file === undefined || file === null ? null : declaredAsByFile.get(file);

        for (const { local, shown } of renames(block[1]))
        {
            // Keyed on the name the declaration carries where it is declared;
            // the value is the name a reader types in an import.
            shownBy.set(declaredAs?.get(local) ?? local, shown);
        }
    }

    for (const single of source.matchAll(/^export\s+(?:declare\s+)?(?:function|class|const|interface|type)\s+(\w+)/gm))
    {
        shownBy.set(single[1], single[1]);
    }

    return shownBy;
}

// A namespace object reaches its members only through the name it is exported
// under: `transport.TransportFault` works, a bare `TransportFault` does not.
// tsup builds one per plugin as `declare namespace api$2 { export { ... } }`,
// aliasing each member through a `api$2_Thing` shim. Followed back to the
// declaration each shim points at, so the member prints its real signature
// under the namespace that owns it.
function namespaces(lines, shownBy)
{
    const byName = new Map();

    // Only tsup's generated namespace objects, which it always names `api`,
    // `api$1`, `api$2`. A hand-written `declare namespace definePlugin` merged
    // onto a function is a different thing entirely: the function is imported
    // and called normally, and rewriting it into a namespace section both hid
    // the function and invented members nobody can import.
    const opener = /^declare namespace\s+(api(?:\$\d+)?)\s*\{/;

    for (let at = 0; at < lines.length; at++)
    {
        const start = opener.exec(lines[at]);

        if (start === null || !shownBy.has(start[1]))
        {
            continue;
        }

        // The body is the lines up to the closing brace at column 0.
        const body = [];

        for (let line = at + 1; line < lines.length && !/^\}/.test(lines[line]); line++)
        {
            body.push(lines[line]);
        }

        const members = new Map();

        for (const block of body.join("\n").matchAll(/export\s*\{([^}]*)\}/g))
        {
            for (const { local, shown } of renames(block[1]))
            {
                members.set(local, shown);
            }
        }

        byName.set(start[1], { shown: shownBy.get(start[1]), members });
    }

    return byName;
}

function signature(declaration)
{
    // A signature can run over several lines when a parameter or a return is
    // an inline object. Taking the first line alone truncated it into
    // TypeScript that does not parse.
    const oneLiner = declaration.kind === "function" || declaration.kind === "const";
    const source = oneLiner
        ? declaration.body.map((line) => line.trim()).join(" ").replace(/\s+/g, " ").replace(/;\s*\}/g, " }")
        : declaration.body[0];

    let first = source
        .replace(/^export\s+/, "")
        .replace(/^declare\s+/, "")
        .replace(/^(function|class|const|interface|type)\s+/, "")
        .replace(/;$/, "")
        .replace(/\s*\{\s*$/, "");

    // An alias carries its whole definition on the heading line. A union is
    // worth reading there; anything longer belongs under the name, so the
    // heading stays a name a reader can scan.
    let longUnion = [];

    if (declaration.kind === "type")
    {
        // Split on the alias's own "=", never on the "=" inside a "=>": doing
        // that lost the arrow and a callable alias printed as a bare name.
        const split = first.search(/\s*=(?!>)\s*/);
        const name = split < 0 ? first : first.slice(0, split).trim();
        const body = split < 0 ? "" : first.slice(split).replace(/^\s*=(?!>)\s*/, "").trim();

        // A union of literals IS the documentation: the values are what a
        // caller branches on. Wrapped rather than dropped, however long.
        if (body === "")
        {
            first = name;
        }
        else if (body.length <= 120)
        {
            first = `${name} = ${body}`;
        }
        else if (/^"/.test(body) && body.includes("|"))
        {
            first = name;
            longUnion = body.split("|").map((arm) => `    | ${arm.trim()}`);
        }
        else if (/^\(/.test(body) && body.includes("=>"))
        {
            // A callable alias IS its signature: dropping it left a name a
            // caller had to guess, and two builds guessed the arity wrong.
            first = `${name} = ${body}`;
        }
        else
        {
            first = name;
        }
    }

    // A type alias says everything on its first line; the rest carry a body.
    // A union of object arms reads as one expression. Split into fields it
    // renders as `} | {` sitting among them — TypeScript that does not parse,
    // and the reader cannot tell the arms apart.
    if (declaration.body.some((line) => /^\s*\}\s*[|&]/.test(line)))
    {
        const whole = declaration.body
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/**"))
            .join(" ")
            .replace(/\s+/g, " ")
            .replace(/;\s*\}/g, " }")
            .replace(/;$/, "");

        return { first: whole.replace(/^(export\s+)?(declare\s+)?(type|interface)\s+/, ""), fields: [], comment: declaration.comment };
    }

    const fields = [];

    for (const raw of declaration.body.slice(1, -1))
    {
        const line = raw.trim();

        if (line === "" || line === "/**" || line === "*/" || line.startsWith("//"))
        {
            continue;
        }

        if (line.startsWith("*") || line.startsWith("/**"))
        {
            const comment = line.replace(/^\/\*\*\s?/, "").replace(/\s*\*\/$/, "").replace(/^\*\s?/, "").trim();

            if (comment !== "")
            {
                fields.push(`    // ${comment}`);
            }

            continue;
        }

        fields.push(`    ${line.replace(/;$/, "")}`);
    }

    return { first, fields: longUnion.length > 0 ? longUnion : fields, comment: declaration.comment };
}

const written = [];

for (const entry of entryPoints())
{
    // tsup splits shared declarations into a hashed chunk and re-exports them
    // under short aliases, so the entry alone carries only a fraction of the
    // surface. Every chunk it imports from is read as well.
    const entrySource = readFileSync(entry.file, "utf8");
    const folder = entry.file.replace(/\/[^/]+$/, "");
    const chunks = new Set();

    for (const from of entrySource.matchAll(/from\s+["'](\.[^"']+)["']/g))
    {
        const chunk = join(folder, from[1].replace(/\.js$/, ".d.ts"));

        if (existsSync(chunk))
        {
            chunks.add(chunk);
        }
    }

    const chunkSourcesByFile = new Map([...chunks].map((chunk) => [chunk, readFileSync(chunk, "utf8")]));
    const lines = [entrySource, ...chunkSourcesByFile.values()].join("\n").split("\n");
    const shownBy = exported(entrySource, chunkSourcesByFile);
    const grouped = namespaces(entrySource.split("\n"), shownBy);

    // What the entry lists by name, which is what a root `import { ... }` can
    // reach. A namespace member that also appears here is importable both ways.
    const rootExports = new Set(shownBy.keys());

    // Every declaration, by the name it is declared under, so a namespace
    // member's shim can be followed to the thing it aliases.
    const declared = new Map();

    for (const declaration of declarations(lines))
    {
        if (!declared.has(declaration.name))
        {
            declared.set(declaration.name, declaration);
        }
    }

    // A member reached through `api$2_TransportFault = TransportFault` is that
    // declaration under another name. The shim is followed once; what it points
    // at carries the signature and the sentence above it.
    function behind(local)
    {
        const shim = /^api(?:\$\d+)?_(.+)$/.exec(local);
        const target = shim === null ? local : shim[1];

        return declared.get(target) ?? declared.get(local) ?? null;
    }

    // Namespace members are printed under their namespace, never loose: a
    // member's own declaration name is not importable on its own.
    //
    // Unless the entry exports it at root as well. `Cache` is both a root
    // export and `cache.Cache`; suppressing it everywhere but the namespace
    // lost a name that a reader can, in fact, import directly.
    const insideNamespace = new Set();

    for (const { members } of grouped.values())
    {
        for (const member of members.keys())
        {
            const shim = /^api(?:\$\d+)?_(.+)$/.exec(member);
            const declaration = shim === null ? member : shim[1];

            if (!rootExports.has(declaration))
            {
                insideNamespace.add(member);
                insideNamespace.add(declaration);
            }
        }
    }

    const groups = { Functions: [], Classes: [], Types: [] };

    function place(declaration, heading)
    {
        const group = declaration.kind === "function" || declaration.kind === "const"
            ? "Functions"
            : declaration.kind === "class" ? "Classes" : "Types";

        groups[group].push({ ...signature(declaration), first: heading });
    }

    for (const declaration of declarations(lines))
    {
        // tsup emits `type api_Thing = Thing` to build its namespace objects.
        // The alias is not a declaration anyone can import, and the thing it
        // points at is printed under the namespace that carries it.
        if (/^api(\$\d+)?_/.test(declaration.name) || grouped.has(declaration.name))
        {
            continue;
        }

        if (insideNamespace.has(declaration.name) || !shownBy.has(declaration.name))
        {
            continue;
        }

        // The public name, not the local one: a chunk may declare `a` and the
        // entry show it as `KernelOptions`.
        const shown = shownBy.get(declaration.name);
        const { first } = signature(declaration);

        place(declaration, declaration.name === shown ? first : first.replace(declaration.name, shown));
    }

    written.push(`# ${entry.name}`);

    for (const [group, items] of Object.entries(groups))
    {
        if (items.length === 0)
        {
            continue;
        }

        written.push(``, `## ${group}`, ``);

        for (const declaration of items.sort((left, right) => left.first.localeCompare(right.first)))
        {
            written.push(...declaration.comment.map((line) => `> ${line}`));
            written.push(`### ${declaration.first}`);
            written.push(...declaration.fields);
            written.push(``);
        }
    }

    // Namespaces last, each under its own heading: the heading names the only
    // import that reaches the members, and every member below it is written
    // dotted, so a reader copies `transport.TransportFault` and it compiles.
    for (const { shown, members } of [...grouped.values()].sort((left, right) => left.shown.localeCompare(right.shown)))
    {
        written.push(``, `## ${shown}`, ``, `Imported whole, then reached through the name: \`import { ${shown} } from "${entry.name}";\`. Its members have no import of their own.`, ``);

        for (const member of [...members].sort((left, right) => left[1].localeCompare(right[1])))
        {
            const declaration = behind(member[0]);

            if (declaration === null)
            {
                continue;
            }

            const { first, fields, comment } = signature(declaration);

            written.push(...comment.map((line) => `> ${line}`));
            written.push(`### ${shown}.${first.replace(declaration.name, member[1])}`);
            written.push(...fields);
            written.push(``);
        }
    }

    written.push(``);
}

writeFileSync(OUT, `${written.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`);

console.log(`${OUT}: ${written.filter((line) => line.startsWith("### ")).length} declarations`);
