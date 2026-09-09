import { database, migrationSteps, noStore } from "../../database/api";
import { limiter, unlimited } from "../../guard/api";
import { createKernel, order, tableIndexes } from "../../kernel/api";
import { dial } from "../../outbound/api";
import { serve, sockets } from "../../http/api";
import type { DatabaseOptions, Store } from "../../database/api";
import type { Plugin } from "../../kernel/api";
import type { RunningApp, StartOptions } from "../api";

/** The store to run on: the project's own, one opened here, or none at all. */
function storeFor(given: StartOptions["database"], withTables: readonly Plugin[]): Store
{
    if (given === undefined)
    {
        return noStore();
    }

    if (typeof (given as { tx?: unknown }).tx === "function")
    {
        return given as Store;
    }

    return database({
        ...given as DatabaseOptions,
        tables: Object.fromEntries(
            withTables.map((plugin) => [plugin.name, plugin.definition.tables as Readonly<Record<string, unknown>>]),
        ),
    });
}


/** One index a table declares that no migration creates. */
type UnmigratedIndex = {
    plugin: string;
    table: string;
    name: string;
    unique: boolean;
};

/**
 * Declared indexes no migration creates.
 *
 * Two places hold the same truth here: the table says an index exists, the
 * migration is what actually makes one. A uniqueIndex declared and never
 * created reads as a guarantee and accepts the duplicate it was there to
 * refuse, with nothing failing.
 *
 * Read from the migration files rather than from what a boot applied: the
 * second boot applies nothing.
 */
function missingIndexes(plugins: readonly Plugin[], sources: readonly { plugin: string; from: string }[]): UnmigratedIndex[]
{
    const declared: UnmigratedIndex[] = [];

    for (const plugin of plugins)
    {
        for (const [key, table] of Object.entries(plugin.definition.tables ?? {}))
        {
            for (const index of tableIndexes(table))
            {
                declared.push({ plugin: plugin.name, table: key, name: index.name, unique: index.unique });
            }
        }
    }

    if (declared.length === 0)
    {
        return [];
    }

    let sql = "";

    for (const source of sources)
    {
        for (const step of migrationSteps(source))
        {
            sql += `${step.sql}\n`;
        }
    }

    const created = new Set(
        [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi)]
            .map((found) => found[1] ?? ""),
    );

    return declared.filter((one) => !created.has(one.name));
}


/** One migration reaching a table another plugin owns, undeclared. */
type UndeclaredRead = {
    plugin: string;
    table: string;
    owner: string;
};

/**
 * Migrations reading a table another plugin owns without depending on it.
 *
 * A cross-plugin import is checked against `dependsOn`, and SQL is the one
 * place that rule was never enforced: a migration naming another plugin's
 * table works only because ties break by name, so the same file refuses the
 * day its plugin is renamed to sort first.
 */
function undeclaredReads(plugins: readonly Plugin[], sources: readonly { plugin: string; from: string }[]): UndeclaredRead[]
{
    const sqlOf = new Map<string, string>();

    for (const source of sources)
    {
        let sql = "";

        for (const step of migrationSteps(source))
        {
            sql += `${step.sql}\n`;
        }

        sqlOf.set(source.plugin, sql);
    }

    // Owned by whoever creates it, not by whoever declared a table object: a
    // migration is what actually makes one, and only what exists can be read.
    const owner = new Map<string, string>();

    for (const [plugin, sql] of sqlOf)
    {
        for (const found of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi))
        {
            owner.set((found[1] ?? "").toLowerCase(), plugin);
        }
    }

    const declared = new Map(plugins.map((plugin) => [plugin.name, new Set(plugin.definition.dependsOn ?? [])]));
    const crossings: UndeclaredRead[] = [];
    const seen = new Set<string>();

    for (const [plugin, sql] of sqlOf)
    {
        for (const found of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+"?([A-Za-z0-9_]+)"?/gi))
        {
            const table = (found[1] ?? "").toLowerCase();
            const owns = owner.get(table);

            if (owns === undefined || owns === plugin || declared.get(plugin)?.has(owns) === true)
            {
                continue;
            }

            const key = `${plugin}/${table}`;

            if (!seen.has(key))
            {
                seen.add(key);
                crossings.push({ plugin, table, owner: owns });
            }
        }
    }

    return crossings;
}

// The order is the point: the database opens and migrates before any plugin
// runs, the kernel validates before any plugin acts, and the server is built
// last, from routes that are already known to be sound.
export async function start(starting: StartOptions): Promise<RunningApp>
{
    const log = starting.log;

    const withTables = starting.plugins.filter((plugin) => plugin.definition.tables !== undefined);

    // Named rather than counted: an api that will not start says which plugin
    // wants the database, so nobody goes looking for it.
    if (starting.database === undefined && withTables.length > 0)
    {
        throw new TypeError(
            `${withTables.map((plugin) => `"${plugin.name}"`).join(", ")} declare tables, and start() was given no database. Pass one: database: { file: "./data/app.db" }, or a store of your own.`,
        );
    }

    // A store the project built, or one opened here from a path. Told apart
    // by what it answers to, not by a flag: a Store has methods, a
    // DatabaseOptions has a file.
    const store = storeFor(starting.database, withTables);

    // In dependency order, so a plugin's tables exist before one depending on
    // it references them. The same order the kernel starts them in.
    const migrations = order(new Map(starting.plugins.map((plugin) => [plugin.name, plugin])))
        .filter((plugin) => plugin.definition.migrations !== undefined)
        .map((plugin) => ({ plugin: plugin.name, from: plugin.definition.migrations as string }));

    if (typeof store.migrate !== "function" || typeof store.close !== "function")
    {
        throw new TypeError(
            "The store given to start() answers tx and of, but not migrate and close. start() owns the whole lifetime of a database, so it needs both: migrate before any plugin runs, close after every one has stopped. Add them, or build the kernel yourself with createKernel, which asks only for tx and of.",
        );
    }

    // Read before migrating rather than from what migrating returned: a
    // second boot applies nothing, and a check over an empty list would call
    // every index missing.
    const unmigrated = missingIndexes(starting.plugins, migrations);

    if (unmigrated.length > 0)
    {
        throw new TypeError(
            `${unmigrated.length} declared ${unmigrated.length === 1 ? "index is" : "indexes are"} in no migration, so ${unmigrated.length === 1 ? "it never reaches" : "they never reach"} the database:\n${unmigrated.map((one) => `  - ${one.plugin}: ${one.unique ? "uniqueIndex" : "index"} "${one.name}" on "${one.table}". A uniqueIndex nothing created accepts the duplicate it was declared to stop. Add CREATE ${one.unique ? "UNIQUE " : ""}INDEX ${one.name} to a migration, or drop the declaration.`).join("\n")}`,
        );
    }

    const crossings = undeclaredReads(starting.plugins, migrations);

    if (crossings.length > 0)
    {
        throw new TypeError(
            `${crossings.length} ${crossings.length === 1 ? "migration reaches a table" : "migrations reach tables"} another plugin owns without depending on it:\n${crossings.map((one) => `  - ${one.plugin}: reads "${one.table}", which "${one.owner}" creates. It works only while names happen to sort that way, and refuses the day either is renamed. Add "${one.owner}" to dependsOn, or stop reading its table.`).join("\n")}`,
        );
    }

    const steps = store.migrate(migrations);

    if (steps.length > 0)
    {
        log?.info("migrations applied", { count: steps.length, steps: steps.map((step) => `${step.plugin}/${step.name}`) });
    }

    // Every route's declared limit is enforced by this one, so a plugin cannot
    // turn off its own: it never holds it. A budget the project passed counts
    // wherever it likes, which is what more than one process needs; the kit's
    // own counts here, and only what it counted can it sweep.
    if (starting.limits === false)
    {
        log?.warn("RATE LIMITS ARE NOT BEING COUNTED", {
            meaning: "every route's declared budget is ignored: nothing answers 429, however often it is called",
            turnOn: "remove limits: false, or leave it out entirely",
        });
    }

    // Said rather than refused, because how much a stranger may ask for is
    // the project's call and not the kit's: one behind a proxy that counts
    // for it is right to declare nothing. What is never right is not
    // knowing. A public route is the whole internet by declaration, and
    // without a budget it is the whole internet as often as it likes.
    //
    // Here rather than in validate(), because a test builds its kernel with
    // createKernel and declares no limits on purpose: this is the production
    // path, and only the production path.
    const unbounded = starting.plugins
        .flatMap((plugin) => (plugin.definition.routes ?? []).map((route) => ({ plugin: plugin.name, route })))
        .filter(({ route }) => route.public === true && route.limit === undefined)
        .map(({ plugin, route }) => `${plugin}: ${route.method} ${route.path}`);

    if (unbounded.length > 0)
    {
        log?.warn("PUBLIC ROUTES WITH NO LIMIT", {
            meaning: "anyone on the internet may call these as often as they like, and nothing answers 429",
            routes: unbounded,
            turnOn: "declare limit: { requests, seconds } on each, or count them in front of this process",
        });
    }

    const ourLimiter = starting.budget === undefined && starting.limits !== false ? limiter() : undefined;
    const budget = starting.budget ?? ourLimiter ?? unlimited();

    const sweep = ourLimiter === undefined ? undefined : setInterval(() => void ourLimiter.sweep(), 60_000);

    sweep?.unref?.();

    // Reached through the store's own connection, so a kept event and the
    // work it announces are written by one transaction.
    const outbox = starting.outbox === true ? store.outbox?.() : undefined;
    const later = starting.schedule === true ? store.schedule?.() : undefined;

    // Given whenever any plugin declares a scope: the kernel refuses to
    // narrow without it, and a plugin declaring one and finding nothing to
    // narrow by would be a scope that does not scope.
    const scoping = starting.plugins.some((plugin) => plugin.definition.scope !== undefined);

    // Built before the kernel it reads from, and handed a way back to it: a
    // kernel holds this, so it cannot be given one already made.
    const wires = starting.sockets === false
        ? undefined
        : sockets({ channels: () => kernel.channels() }, typeof starting.sockets === "object" ? starting.sockets.claim : undefined);

    const kernel = createKernel({
        plugins: starting.plugins,
        db: store,
        ...(wires !== undefined && { sockets: wires }),
        ...(outbox !== undefined && { outbox }),
        ...(later !== undefined && { schedule: later }),
        ...(scoping && store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        budget,
        dial: typeof starting.outbound === "function" ? starting.outbound : dial(starting.outbound ?? {}),
        ...(starting.config !== undefined && { config: starting.config }),
        ...(log !== undefined && {
            log: (level, plugin, line, about) =>
            {
                log[level](`${plugin}: ${line}`, about);
            },
        }),
    });

    await kernel.start();

    log?.info("kernel started", { plugins: starting.plugins.length, routes: kernel.routes().length });

    // Built after the kernel started, so what identifies a caller can reach
    // the plugin holding the sessions.
    const identify = starting.identify?.(kernel);

    const app = serve({
        kernel,
        ...(identify !== undefined && { identify }),
        ...(starting.http ?? {}),
        ...(log !== undefined && {
            log: (level, line, about) =>
            {
                log[level](line, about);
            },
        }),
    });

    return {
        kernel,
        store,
        app,
        fetch: app.fetch,
        sockets: wires === undefined ? undefined : { joined: wires.joined },

        stop: async (): Promise<void> =>
        {
            if (sweep !== undefined)
            {
                clearInterval(sweep);
            }

            await kernel.stop();
            store.close();
        },
    };
}
