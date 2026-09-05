import { database } from "../../database/api";
import { limiter } from "../../guard/api";
import { createKernel } from "../../kernel/api";
import { dial } from "../../outbound/api";
import { serve } from "../../http/api";
import type { DatabaseOptions, Store } from "../../database/api";
import type { RunningApp, StartOptions } from "../api";

// The order is the point: the database opens and migrates before any plugin
// runs, the kernel validates before any plugin acts, and the server is built
// last, from routes that are already known to be sound.
export async function start(starting: StartOptions): Promise<RunningApp>
{
    const log = starting.log;

    // A store the project built, or one opened here from a path. Told apart
    // by what it answers to, not by a flag: a Store has methods, an DatabaseOptions
    // has a file.
    const given = starting.database;
    const ready = typeof (given as { tx?: unknown }).tx === "function";

    const store = ready
        ? given as Store
        : database({
            ...given as DatabaseOptions,
            tables: Object.fromEntries(
                starting.plugins
                    .filter((plugin) => plugin.definition.tables !== undefined)
                    .map((plugin) => [plugin.name, plugin.definition.tables as Readonly<Record<string, unknown>>]),
            ),
        });

    const migrations = starting.plugins
        .filter((plugin) => plugin.definition.migrations !== undefined)
        .map((plugin) => ({ plugin: plugin.name, from: plugin.definition.migrations as string }));

    if (typeof store.migrate !== "function" || typeof store.close !== "function")
    {
        throw new TypeError(
            "The store given to start() answers tx and of, but not migrate and close. start() owns the whole lifetime of a database, so it needs both: migrate before any plugin runs, close after every one has stopped. Add them, or build the kernel yourself with createKernel, which asks only for tx and of.",
        );
    }

    const ran = store.migrate(migrations);

    if (ran.length > 0)
    {
        log?.info("migrations applied", { count: ran.length, steps: ran.map((step) => `${step.plugin}/${step.name}`) });
    }

    // Every route's declared limit is enforced by this one, so a plugin
    // cannot turn off its own: it never holds it.
    // A budget the project passed counts wherever it likes, which is what a
    // deployment of more than one process needs. The kit's own counts here,
    // and only what it counted can it sweep.
    const counting = starting.budget === undefined ? limiter() : undefined;
    const budget = starting.budget ?? counting ?? limiter();

    const sweeping = counting === undefined ? undefined : setInterval(() => void counting.sweep(), 60_000);

    sweeping?.unref?.();

    // Reached through the store's own connection, so a kept event and the
    // work it announces are written by one transaction.
    const keeping = starting.outbox === true ? store.outbox?.() : undefined;
    const later = starting.schedule === true ? store.schedule?.() : undefined;

    // Given whenever any plugin declares a scope: the kernel refuses to
    // narrow without it, and a plugin declaring one and finding nothing to
    // narrow by would be a scope that does not scope.
    const scoping = starting.plugins.some((plugin) => plugin.definition.scope !== undefined);

    const kernel = createKernel({
        plugins: starting.plugins,
        db: store,
        ...(keeping !== undefined && { outbox: keeping }),
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
            if (sweeping !== undefined)
            {
                clearInterval(sweeping);
            }

            await kernel.stop();
            store.close();
        },
    };
}
