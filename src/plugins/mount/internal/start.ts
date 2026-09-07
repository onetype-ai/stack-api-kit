import { database, noStore } from "../../database/api";
import { limiter, unlimited } from "../../guard/api";
import { createKernel, order } from "../../kernel/api";
import { dial } from "../../outbound/api";
import { serve } from "../../http/api";
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

    const kernel = createKernel({
        plugins: starting.plugins,
        db: store,
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
