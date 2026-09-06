import { AsyncLocalStorage } from "node:async_hooks";

import type { Caller, Context, Outbound, Plugin } from "./contract";
import type { events, Pending } from "./events";
import { Refusal } from "./answer";
import { KernelFault } from "./faults";
import type { hooks } from "./hooks";
import { permissions } from "./permissions";
import type { Dialer, ScopeFilter, Outbox, Schedule, Storage } from "./store";

/** Everything a context is built from. One object, so the shape is one line. */
export type Wiring = {
    known: ReadonlyMap<string, Plugin>;
    parsed: ReadonlyMap<string, unknown>;
    /**
     * Which transaction the running code is inside, if any.
     *
     * Per call stack rather than per process: a field would say a transaction
     * is open somewhere, never that *this* caller is the one inside it, so a
     * request emitting outside any transaction would have its event held
     * against a stranger's, and lost when that stranger rolled back.
     */
    open: AsyncLocalStorage<object>;
    config: Readonly<Record<string, unknown>>;
    bus: ReturnType<typeof events<Context>>;
    points: ReturnType<typeof hooks<Context>>;
    pending: Map<object, Pending[]>;

    /** What each plugin owns: one thing, living as long as the kernel does. */
    owned: Map<string, unknown>;
    db: Storage | undefined;

    /** Where events wait for delivery, when the project gave one. */
    outbox: Outbox | undefined;

    dial: Dialer | undefined;

    /** What the project calls the current time. */
    now: () => number;

    /** Where later work waits, when the project gave somewhere. */
    schedule: Schedule | undefined;

    /** How a declared scope becomes a condition. */
    narrow: ScopeFilter | undefined;
    log: (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;
    run: (command: string, input: unknown, caller?: Caller) => Promise<void>;
};

/** Where in a transaction a context sits, if it is in one at all. */
type OpenTx = {
    mark: object;
    db: unknown;
};

/**
 * What an absent dependency answers: a refusal naming what to pass.
 *
 * `used` is what the plugin called; `pass` is the option that supplies it.
 * They are rarely the same word, and saying only the first sends a reader
 * looking for an option that does not exist.
 */
function absent(what: string, used: string, pass: string): never
{
    throw new KernelFault(
        "NOT_STARTED",
        `A plugin used ctx.${used}, but no ${what} was given. Pass \`${pass}\` to createKernel, \`${pass}: true\` to start, or \`${pass}: true\` to startTestKernel in a test.`,
    );
}

/** The origin of a url, whatever its scheme, or undefined when it is not one. */
function origin(url: string): string | undefined
{
    try
    {
        const parsed = new URL(url);

        // `origin` is "null" for schemes the URL standard calls opaque, which
        // is most of them once past http: build it back from the parts, so a
        // declared redis:// host is comparable to the one being dialled.
        return parsed.origin === "null" || parsed.origin === ""
            ? `${parsed.protocol}//${parsed.host}`
            : parsed.origin;
    }
    catch
    {
        return undefined;
    }
}

/** Whether ctx.fetch can carry a call to this url at all. */
function dialable(url: string): boolean
{
    return url.toLowerCase().startsWith("https://");
}

/**
 * Builds what one plugin sees, for one caller.
 *
 * Built per request rather than kept: one kernel answers every request, and a
 * context holding a caller would hand the next request the previous one.
 */
export function context(wiring: Wiring, plugin: string, caller?: Caller, within?: OpenTx, headers: Readonly<Record<string, string>> = {}, acting?: string): Context
{
    const may = permissions(() => caller);
    const seenBy = (plugin: string, inside = within): Context =>
    {
        return context(wiring, plugin, caller, inside, headers, acting);
    };

    /** What a listener is handed: this plugin, and nobody calling. */
    const heard = (plugin: string): Context =>
    {
        return context(wiring, plugin, undefined, undefined, {});
    };

    // Built lazily and once per context: a service reads ctx.caller, so one
    // made at startup would answer every request as nobody. A plugin whose
    // services are never touched builds none.
    const built = new Map<string, unknown>();

    const of = (name: string): unknown =>
    {
        if (built.has(name))
        {
            return built.get(name);
        }

        built.set(name, undefined);

        const services = wiring.known.get(name)?.definition.services?.(
            (name === plugin ? ctx : seenBy(name)) as never,
        );

        built.set(name, services);

        return services;
    };

    /**
     * What a declared scope resolves to for this caller.
     *
     * Shared by `scoped` and `stamped`, because a read and a write must agree
     * about whose rows these are: two lookups is two chances to disagree.
     */
    const scopeFor = (table: string): { column: string; tenant: string } =>
    {
        const scope = wiring.known.get(plugin)?.definition.scope;

        if (scope === undefined)
        {
            throw new KernelFault(
                "UNDECLARED_SCOPE",
                `"${plugin}" asked to scope "${table}", but declares no scope. Add one, naming the claim and which column each table carries it in.`,
                { plugin },
            );
        }

        // hasOwn, not an index: "toString" would answer with a function, and
        // a column nobody declared would be spread into a write.
        const column = Object.hasOwn(scope.tables, table) ? scope.tables[table] : undefined;

        if (column === undefined)
        {
            throw new KernelFault(
                "UNDECLARED_SCOPE",
                `"${plugin}" asked to scope "${table}", which its scope does not name. Add it, or stop scoping a table nobody owns.`,
                { plugin },
            );
        }

        // Refused, never defaulted: a default tenant is everybody's.
        const tenant = caller === undefined ? acting : caller.claims[scope.claim];

        if (typeof tenant !== "string" || tenant.trim() === "")
        {
            throw new Refusal(
                403,
                "OUT_OF_SCOPE",
                "This request carries nothing to say whose rows it may reach.",
            );
        }

        return { column, tenant };
    };

    const ctx: Context = {
        name: plugin,
        config: wiring.parsed.get(plugin) ?? wiring.config[plugin],

        get services(): unknown
        {
            return of(plugin);
        },

        caller,
        headers,

        now: wiring.now,

        log: {
            debug: (line, about) =>
            {
                wiring.log("debug", plugin, line, about);
            },
            info: (line, about) =>
            {
                wiring.log("info", plugin, line, about);
            },
            warn: (line, about) =>
            {
                wiring.log("warn", plugin, line, about);
            },
            error: (line, about) =>
            {
                wiring.log("error", plugin, line, about);
            },
        },

        get db(): unknown
        {
            if (within !== undefined)
            {
                return within.db;
            }

            return wiring.db === undefined ? absent("store", "db", "db") : wiring.db.of(plugin);
        },

        write: <Returned,>(run: () => Promise<Returned>): Promise<Returned> =>
        {
            // Inside a transaction the ordering is already settled: the work
            // belongs to that transaction, and queueing it would wait on a
            // turn that cannot come until the transaction it is inside ends.
            if (within !== undefined || wiring.db?.write === undefined)
            {
                return run();
            }

            return wiring.db.write(run);
        },

        tx: async <Returned,>(run: (ctx: Context) => Promise<Returned>): Promise<Returned> =>
        {
            const store = wiring.db;

            if (store === undefined)
            {
                return absent("store", "db", "db");
            }

            const mark = {};
            const outer = wiring.open.getStore();
            const nested = within !== undefined;

            wiring.pending.set(mark, []);

            try
            {
                // An inner tx becomes a savepoint rather than a second
                // transaction, but keeps its own buffer: work it rolled back
                // must not be announced when the outer commits.
                const returned = await wiring.open.run(mark, () =>
                    store.tx(plugin, async (db) =>
                    {
                        const answer = await run(seenBy(plugin, { mark, db }));

                        // Written with the work, not after it: an event kept
                        // once the transaction has closed is one the process
                        // can still die without.
                        const waiting = wiring.pending.get(mark) ?? [];

                        if (wiring.outbox !== undefined && waiting.length > 0 && !(nested && outer !== undefined))
                        {
                            wiring.outbox.keep(db, waiting.map((one) => ({
                                id: one.id,
                                plugin: one.plugin,
                                name: one.name,
                                payload: one.payload,
                            })));
                        }

                        return answer;
                    }));

                const announced = wiring.pending.get(mark) ?? [];

                if (nested && outer !== undefined)
                {
                    // An inner transaction is a savepoint: the outer one may
                    // still roll back, so what this announced waits on that.
                    wiring.pending.get(outer)?.push(...announced);

                    return returned;
                }

                // Only now: an event about work that rolled back is a lie,
                // and a listener acting on one cannot be undone.
                for (const announcement of announced)
                {
                    const delivered = wiring.bus.deliver(announcement.plugin, announcement.name, announcement.payload, (to) => heard(to));

                    // Forgotten only once something has heard it. Marking it
                    // sent before that would lose exactly what the outbox
                    // exists to keep.
                    void delivered.then((heard) =>
                    {
                        if (heard)
                        {
                            void wiring.outbox?.sent(announcement.id);
                        }
                    });
                }

                return returned;
            }
            finally
            {
                wiring.pending.delete(mark);
            }
        },

        // Async throughout, refusal included: a caller writing `.catch()`
        // around a call would otherwise get an uncaught error for the one
        // case it was guarding against.
        fetch: async (call: Outbound): Promise<unknown> =>
        {
            const allowed = wiring.known.get(plugin)?.definition.outbound ?? [];
            const host = origin(call.url);

            if (host === undefined || !allowed.includes(host))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" called ${host ?? `"${call.url}"`}, which it does not declare. Add it to outbound.`,
                    { plugin },
                );
            }

            // Declared, but not something this can carry. Said plainly,
            // because "add it to outbound" for a host already in outbound
            // sends the reader looking for a problem that is not there.
            if (!dialable(call.url))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" declares ${host}, but ctx.fetch speaks https and nothing else. Reach it with its own client, opened in setup and closed in teardown.`,
                    { plugin },
                );
            }

            return wiring.dial === undefined ? absent("dialer", "dial", "dial") : wiring.dial(call);
        },

        events: {
            emit: (event, payload) =>
            {
                // Checked here even when it is deferred: a payload rejected after
                // a commit, from a stack with no caller in it, is one nobody
                // can trace back to what emitted it.
                const payloadChecked = wiring.bus.checkDeclared(plugin, event, payload);

                // Kept against whatever transaction is open, not against the
                // context this was called on. Emitting from the outer `ctx`
                // inside a `tx` is the easy mistake, and it announced work
                // that had not committed and might never.
                const mark = within?.mark ?? wiring.open.getStore();
                const waiting = mark === undefined ? undefined : wiring.pending.get(mark);

                if (waiting !== undefined)
                {
                    waiting.push({ id: crypto.randomUUID(), plugin, name: event, payload: payloadChecked });

                    return;
                }

                // On nobody's behalf, always. A listener that inherited the
                // emitter's caller would work in one process and answer as
                // nobody after a restart, because an outbox keeps a payload
                // and not a request. Whose work this was travels in the
                // payload or not at all.
                wiring.bus.deliver(plugin, event, payloadChecked, (to) => heard(to));
            },
        },

        hooks: {
            run: (hook, payload) =>
            {
                return wiring.points.run(plugin, hook, payload, (to) => seenBy(to));
            },
        },

        permissions: may,

        commands: {
            run: (command, input) =>
            {
                return wiring.run(command, input, caller);
            },

            later: (command, input, inSeconds) =>
            {
                if (wiring.schedule === undefined)
                {
                    absent("schedule", "commands.later", "schedule");
                }

                const owns = wiring.known.get(plugin)?.definition.commands ?? {};

                // hasOwn, not `in`: "constructor" and "toString" walk the
                // prototype and would be scheduled as if they were declared.
                if (!Object.hasOwn(owns, command))
                {
                    throw new KernelFault(
                        "UNDECLARED_COMMAND",
                        `"${plugin}" scheduled "${command}", which it does not declare. A plugin schedules only its own commands.`,
                        { plugin },
                    );
                }

                // Written by the transaction that asked, when there is one:
                // work scheduled by something that rolled back is work about
                // nothing, and it would run anyway.
                wiring.schedule.keep(within?.db, {
                    id: crypto.randomUUID(),
                    plugin,
                    command,
                    input,
                    at: wiring.now() + inSeconds * 1000,
                    attempts: 0,
                });
            },
        },

        owns: <Owned,>(owned: Owned): Owned =>
        {
            wiring.owned.set(plugin, owned);

            return owned;
        },

        owned: <Owned,>(): Owned | undefined =>
        {
            return wiring.owned.get(plugin) as Owned | undefined;
        },

        forScope: (claim: string): Context =>
        {
            // Only where nobody is calling. Inside a request the scope is
            // decided by who is asking, and letting a handler name another
            // is how a caller reaches rows that are not theirs.
            if (caller !== undefined)
            {
                throw new KernelFault(
                    "OUT_OF_SCOPE",
                    `"${plugin}" called ctx.forScope inside a request. The scope of a request is the caller's; forScope is for a listener or a scheduled command, where nobody is calling.`,
                    { plugin },
                );
            }

            if (claim.trim() === "")
            {
                throw new KernelFault(
                    "OUT_OF_SCOPE",
                    `"${plugin}" called ctx.forScope with nothing. A scope acted for is named, or it is every scope.`,
                    { plugin },
                );
            }

            return context(wiring, plugin, undefined, within, headers, claim);
        },

        stamped: (table: string): Readonly<Record<string, string>> =>
        {
            const { column, tenant } = scopeFor(table);

            return { [column]: tenant };
        },

        scoped: <Condition,>(table: string): Condition =>
        {
            const { column, tenant } = scopeFor(table);

            return (wiring.narrow === undefined
                ? absent("createScopeFilter", "scoped", "narrow")
                : wiring.narrow(table, column, tenant)) as Condition;
        },

        use: <Reached,>(name: string): Reached =>
        {
            const declared = wiring.known.get(plugin)?.definition.dependsOn ?? [];

            if (name !== plugin && !declared.includes(name))
            {
                throw new KernelFault(
                    "UNDECLARED_DEPENDENCY",
                    `"${plugin}" reached "${name}", which it does not depend on. Add "${name}" to dependsOn.`,
                    { plugin },
                );
            }

            // The other plugin's services, against this same caller. One
            // built at startup would answer as whoever asked first.
            return of(name) as Reached;
        },
    };

    return ctx;
}
