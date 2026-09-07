//
// Folders as one readable file, and back again.
//

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** What a Packer owns, and what it may fold out of it. */
export type Packing = {
    /** The folder it owns, from the working directory. */
    at: string;

    /** What may be packed out of it, when nothing is named. */
    demo?: readonly string[];

    /** What one of them is called, for a message a reader reads. */
    name: string;

    /** Where the packed file goes. Left out, `example.txt` beside them. */
    into?: string;

    /** The file a project runs, named in the usage line. */
    tool: string;

    /**
     * The most characters one packed file may hold, or 0 for no limit.
     *
     * A document past it is refused at the pack rather than at a test: a
     * limit that has to be measured is one nobody was watching anyway.
     *
     * A function answers per file, because a reference is searched where a
     * procedure is read, and the two do not fit one number.
     */
    limit?: number | ((path: string) => number);
};

/**
 * One folder, folded into one file and back.
 *
 * Packing writes the file beside what it read and removes the originals, so
 * there is one copy rather than two that drift apart. Reading that file is
 * meant to replace walking the tree: every path and every line, in the order
 * somebody would read them.
 */
export class Packer
{
    readonly mark = "==> ";

    readonly ends = "# EXAMPLES END HERE";

    readonly root: string;

    readonly folder: string;

    readonly file: string;

    readonly whole: boolean;

    readonly demo: readonly string[];

    readonly name: string;

    readonly at: string;

    readonly tool: string;

    readonly limit: number | ((path: string) => number);

    constructor({ at, demo, name, into, tool, limit }: Packing)
    {
        this.tool = tool;
        this.root = process.cwd();
        this.folder = join(this.root, ...at.split("/"));
        this.file = into === undefined ? join(this.folder, "example.txt") : join(this.root, into);
        this.whole = into !== undefined;
        this.demo = demo ?? [];
        this.name = name;
        this.at = at;
        this.limit = limit ?? 0;
    }

    pack(asked: readonly string[]): void
    {
        const names = asked.length > 0 ? [...asked] : [...this.demo];

        for (const name of names)
        {
            if (!existsSync(this.pathFor(name)))
            {
                throw new Error(`No ${this.name} named "${name}" in ${this.at}/, so nothing was packed.`);
            }
        }

        const inOrder = (first: string, second: string): number =>
        {
            return this.weigh(first) - this.weigh(second) || first.localeCompare(second);
        };

        const files = this.whole
            ? this.walk(this.folder).sort(inOrder)
            : names.flatMap((name) => this.walk(this.pathFor(name)).sort(inOrder));

        if (files.length === 0)
        {
            throw new Error(`Those ${this.name}s hold no files, so nothing was packed.`);
        }

        let packed = this.head(names);

        for (const file of files)
        {
            const path = relative(this.root, file).split(sep).join("/");
            const body = readFileSync(file, "utf8");

            if (body.split("\n").some((line) => line.startsWith(this.mark)))
            {
                throw new Error(`${path} holds a line starting with "${this.mark}", which would unpack wrongly.`);
            }

            // Refused here rather than counted later: the writer is the one
            // holding it, and a limit found at a test is one found too late.
            const most = typeof this.limit === "function" ? this.limit(path) : this.limit;

            if (most > 0 && body.length > most)
            {
                throw new Error(`${path} is ${String(body.length)} characters, over the ${String(most)} a ${this.name} may hold.`);
            }

            packed += `\n${this.mark}${path}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
        }

        if (!this.whole)
        {
            packed += `\n${this.ends}\n\nEverything above was an example. What you write goes in its own\nfolder beside them, and nothing here is yours to edit.\n`;
        }

        const losing = files.length;

        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, packed);

        this.clear(this.whole ? undefined : names, (name) => this.pathFor(name));

        const said = this.whole ? this.at : names.join(", ");

        console.log(`packed ${said} (${String(losing)} files) into ${relative(this.root, this.file)}`);
        console.log(`those ${String(losing)} files are now gone from disk. \`unpack\` writes them back.`);
    }

    unpack(): void
    {
        if (!existsSync(this.file))
        {
            throw new Error(`No ${relative(this.root, this.file)} to unpack.`);
        }

        const files = this.read(readFileSync(this.file, "utf8"));

        if (files.length === 0)
        {
            throw new Error(`${relative(this.root, this.file)} names no files, so nothing was written.`);
        }

        for (const [named] of files)
        {
            if (!join(this.root, named).startsWith(`${this.folder}${sep}`))
            {
                throw new Error(`"${named}" is outside ${this.at}/, so nothing was written.`);
            }
        }

        const depth = this.at.split("/").length;
        const names = [...new Set(files.map(([named]) => (named.split("/")[depth] ?? "").replace(/\.tsx?$/, "")))];

        this.clear(this.whole ? undefined : names);

        for (const [named, body] of files)
        {
            const full = join(this.root, named);

            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, body.endsWith("\n") ? body : `${body}\n`);
        }

        const told = this.whole ? this.at : names.join(", ");

        console.log(`unpacked ${told} (${String(files.length)} files) into ${relative(this.root, this.folder)}`);
    }

    /** What a packed file names, in the order it named them. */
    read(packed: string): [string, string][]
    {
        const files: [string, string][] = [];

        let path: string | null = null;
        let body: string[] = [];

        for (const line of packed.split("\n"))
        {
            /* The closing note is not part of the last file: without this it
               is read as its body and written back, growing on every pack. */
            if (line === this.ends)
            {
                break;
            }

            if (line.startsWith(this.mark))
            {
                if (path !== null)
                {
                    files.push([path, body.join("\n")]);
                }

                path = line.slice(this.mark.length).trim();
                body = [];
                continue;
            }

            if (path !== null)
            {
                if (body.length === 0 && line === "")
                {
                    continue;
                }

                body.push(line);
            }
        }

        if (path !== null)
        {
            files.push([path, body.join("\n")]);
        }

        return files;
    }

    pathFor(name: string): string
    {
        const folder = join(this.folder, name);

        return existsSync(folder) && statSync(folder).isDirectory() ? folder : `${folder}.ts`;
    }

    /**
     * Removes what was folded away, keeping the file it was folded into.
     *
     * A pack knows whether a name is a folder or a file beside it, so it
     * resolves one; an unpack has only the name the packed file carried.
     */
    clear(names: readonly string[] | undefined, resolve?: (name: string) => string): void
    {
        if (names !== undefined)
        {
            for (const name of names)
            {
                rmSync(resolve === undefined ? join(this.folder, name) : resolve(name), { recursive: true, force: true });
            }

            return;
        }

        // The packed file may live inside the folder it packs, so the folder
        // is emptied around it rather than removed under it.
        if (!this.file.startsWith(`${this.folder}${sep}`))
        {
            rmSync(this.folder, { recursive: true, force: true });

            return;
        }

        for (const entry of readdirSync(this.folder))
        {
            const path = join(this.folder, entry);

            if (path !== this.file)
            {
                rmSync(path, { recursive: true, force: true });
            }
        }
    }

    walk(at: string): string[]
    {
        if (!statSync(at).isDirectory())
        {
            return at === this.file ? [] : [at];
        }

        const found: string[] = [];

        for (const entry of readdirSync(at))
        {
            const full = join(at, entry);

            if (statSync(full).isDirectory())
            {
                found.push(...this.walk(full));
                continue;
            }

            if (full !== this.file)
            {
                found.push(full);
            }
        }

        return found;
    }

    /** What a reader opens first comes first. */
    weigh(path: string): number
    {
        const name = path.split(sep).pop() ?? "";

        if (name === "plugin.ts" || name === "usage.md")
        {
            return 0;
        }

        return name === "index.ts" || name === "architecture.md" ? 1 : 2;
    }

    head(names: readonly string[]): string
    {
        const said = this.whole ? this.at : names.join(", ");
        const many = this.whole || names.length > 1;

        if (this.whole)
        {
            return `# ${said} packed

Every file of ${many ? `these ${this.name}s` : `this ${this.name}`}, one after another. A line starting
with "${this.mark}" opens a file and names its path; everything until the next
such line is that file, byte for byte.

Read it here. Nothing needs unpacking, and editing this file directly is work
the next pack throws away.
`;
        }

        /* Examples say so at both ends: an agent that joins in the middle
           still learns it is reading a sample, not the application. */
        return `# EXAMPLES START HERE: ${said}

These are example ${this.name}s, here to be read, not the application you are
building. Take the mechanics from them and leave the domain alone: yours has
its own nouns.

Every file of ${many ? `these ${this.name}s` : `this ${this.name}`}, one after another. A line starting
with "${this.mark}" opens a file and names its path; everything until the next
such line is that file, byte for byte.

Read it here. Nothing needs unpacking, and editing this file directly is work
the next pack throws away.
`;
    }

    ran(argv: readonly string[]): void
    {
        try
        {
            this.run(argv);
        }
        catch (error)
        {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        }
    }

    run(argv: readonly string[]): void
    {
        const [asked, ...names] = argv;

        if (asked === "pack")
        {
            this.pack(names);

            return;
        }

        if (asked === "unpack")
        {
            this.unpack();

            return;
        }

        console.error(`Usage: node tools/${this.tool}.mjs pack [name...] | unpack`);
        process.exit(1);
    }
}
