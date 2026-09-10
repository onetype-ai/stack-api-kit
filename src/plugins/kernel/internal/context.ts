import { AsyncLocalStorage } from "node:async_hooks";

import type { Identity, Context, HttpRequest, Plugin } from "./contract";
import type { events, PendingDelivery } from "./events";
import { Refusal } from "./refusal";
import { KernelFault } from "./faults";
import { blockedUrlReason } from "./privateAddress";
import type { hooks } from "./hooks";
import { createPermissions } from "./permissions";
import type { HttpClient, ScopeFilter, Outbox, Schedule, Sockets, KernelStore } from "./store";

/** Everything a context is built from. One object, so the shape is one line. */
export type KernelWiring = {
    known: ReadonlyMap<string, Plugin>;
    settings: ReadonlyMap<string, unknown>;
    /** Which transaction the running code is inside, if any. */
    open: AsyncLocalStorage<object>;
    config: Readonly<Record<string, unknown>>;
    bus: ReturnType<typeof events<Context>>;
    points: ReturnType<typeof hooks<Context>>;
    pending: Map<object, PendingDelivery[]>;

    /** What each plugin owns: one thing, living as long as the kernel does. */
    owned: Map<string, unknown>;
    db: KernelStore | undefined;

    /** What holds the open sockets, when the project started a server. */
    sockets: Sockets | undefined;

    /** Where events wait for delivery, when the project gave one. */
    outbox: Outbox | undefined;

    httpClient: HttpClient | undefined;

    /** What the project calls the current time. */
    now: () => number;

    /** Where later work waits, when the project gave somewhere. */
    schedule: Schedule | undefined;

    /** How a declared scope becomes a condition. */
    scopeFilter: ScopeFilter | undefined;
    log: (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;
    run: (command: string, input: unknown, identity?: Identity) => Promise<void>;
};

/** Where in a transaction a context sits, if it is in one at all. */
type OpenTransaction = {
    mark: object;
    db: unknown;
};

/** What an absent dependency answers: a refusal naming who and what to pass. */
function absentWiring(plugin: string, what: string, used: string, pass: string): never
{
    throw new KernelFault(
        "NOT_STARTED",
        `"${plugin}" used ctx.${used}, but no ${what} was given. Pass \`${pass}\` to createKernel, \`${pass}: true\` to start, or \`${pass}: true\` to startTestKernel in a test.`,
        { plugin },
    );
}

/** The origin of a url, whatever its scheme, or undefined when it is not one. */
function originOf(url: string): string | undefined
{
    try
    {
        const parsed = new URL(url);

        if (parsed.host === "")
        {
            return undefined;
        }

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
function isHttps(url: string): boolean
{
    return url.toLowerCase().startsWith("https://");
}

/** Builds what one plugin sees, for one identity. */
export function context(wiring: KernelWiring, plugin: string, identity?: Identity, openTransaction?: OpenTransaction, headers: Readonly<Record<string, string>> = {}, acting?: string, sent?: Uint8Array): Context
{
    const permissions = createPermissions(() => identity);
    const contextFor = (plugin: string, inside = openTransaction): Context =>
    {
        return context(wiring, plugin, identity, inside, headers, acting, sent);
    };

    /** What a listener is handed: this plugin, and nobody calling. */
    const listenerContext = (plugin: string): Context =>
    {
        return context(wiring, plugin, undefined, undefined, {});
    };

    const built = new Map<string, unknown>();

    const servicesOf = (name: string): unknown =>
    {
        if (built.has(name))
        {
            return built.get(name);
        }

        built.set(name, undefined);

        const services = wiring.known.get(name)?.definition.services?.(
            (name === plugin ? ctx : contextFor(name)) as never,
        );

        built.set(name, services);

        return services;
    };

    /** What a declared scope resolves to for this identity. */
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

        const column = Object.hasOwn(scope.tables, table) ? scope.tables[table] : undefined;

        if (column === undefined)
        {
            throw new KernelFault(
                "UNDECLARED_SCOPE",
                `"${plugin}" asked to scope "${table}", which its scope does not name. Add it, or stop scoping a table nobody owns.`,
                { plugin },
            );
        }

        if (identity === undefined && acting === undefined)
        {
            throw new KernelFault(
                "UNSCOPED_CALLER",
                `"${plugin}" scoped "${table}" where nobody is calling. Name the scope with ctx.forScope(...), or read without scoping.`,
                { plugin },
            );
        }

        const tenant = identity === undefined ? acting : identity.claims[scope.claim];

        if (identity !== undefined && typeof identity.claims[scope.claim] !== "string")
        {
            const claimed = identity.claims[scope.claim];
            const carried = claimed === undefined ? "carries no such claim" : `carries it as ${typeof claimed}, and a scope narrows by a string`;

            throw new KernelFault(
                "UNCLAIMED_SCOPE",
                `"${plugin}" scopes by "${scope.claim}", and the identity answered ${carried}. Put it in the claims identifies returns, or scope by one it carries.`,
                { plugin },
            );
        }

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
        config: wiring.settings.get(plugin) ?? wiring.config[plugin],

        get services(): unknown
        {
            return servicesOf(plugin);
        },

        identity,
        headers,
        sent,

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
            if (openTransaction !== undefined)
            {
                return openTransaction.db;
            }

            return wiring.db === undefined ? absentWiring(plugin, "store", "db", "db") : wiring.db.forPlugin(plugin);
        },

        write: <Returned,>(run: () => Promise<Returned>): Promise<Returned> =>
        {
            if (openTransaction !== undefined || wiring.db?.write === undefined)
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
                return absentWiring(plugin, "store", "db", "db");
            }

            const mark = {};
            const outer = wiring.open.getStore();
            const nested = openTransaction !== undefined;

            wiring.pending.set(mark, []);

            try
            {
                const returned = await wiring.open.run(mark, () =>
                    store.tx(plugin, async (db) =>
                    {
                        const answer = await run(contextFor(plugin, { mark, db }));

                        const queued = wiring.pending.get(mark) ?? [];

                        if (wiring.outbox !== undefined && queued.length > 0 && !(nested && outer !== undefined))
                        {
                            wiring.outbox.save(db, queued.map((event) => ({
                                id: event.id,
                                plugin: event.plugin,
                                name: event.name,
                                payload: event.payload,
                            })));
                        }

                        return answer;
                    }));

                const announced = wiring.pending.get(mark) ?? [];

                if (nested && outer !== undefined)
                {
                    wiring.pending.get(outer)?.push(...announced);

                    return returned;
                }

                for (const announcement of announced)
                {
                    const delivered = wiring.bus.deliver(announcement.plugin, announcement.name, announcement.payload, (to) => listenerContext(to));

                    void delivered.then((listenerContext) =>
                    {
                        if (listenerContext)
                        {
                            void wiring.outbox?.markSent(announcement.id);
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

        fetch: async (call: HttpRequest): Promise<unknown> =>
        {
            const allowed = wiring.known.get(plugin)?.definition.allowedHosts ?? [];
            const host = originOf(call.url);

            if (allowed === "anywhere")
            {
                const blocked = blockedUrlReason(call.url);

                if (blocked !== undefined)
                {
                    throw new KernelFault("UNDECLARED_HOST", `"${plugin}" called an address it may not reach. ${blocked}`, { plugin });
                }

                return wiring.httpClient === undefined ? absentWiring(plugin, "httpClient", "fetch", "httpClient") : wiring.httpClient(call);
            }

            if (host === undefined)
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" called "${call.url}", which is not an address.`,
                    { plugin },
                );
            }

            if (!allowed.includes(host))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" called ${host}, which it does not declare. Add it to outbound.`,
                    { plugin },
                );
            }

            if (!isHttps(call.url))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" declares ${host}, but ctx.fetch speaks https and nothing else. ChannelReach it with its own client, opened in setup and closed in teardown.`,
                    { plugin },
                );
            }

            return wiring.httpClient === undefined ? absentWiring(plugin, "httpClient", "fetch", "httpClient") : wiring.httpClient(call);
        },

        events: {
            emit: (event, payload) =>
            {
                const payloadChecked = wiring.bus.checkDeclared(plugin, event, payload);

                const mark = openTransaction?.mark ?? wiring.open.getStore();
                const queued = mark === undefined ? undefined : wiring.pending.get(mark);

                if (queued !== undefined)
                {
                    queued.push({ id: crypto.randomUUID(), plugin, name: event, payload: payloadChecked });

                    return;
                }

                wiring.bus.deliver(plugin, event, payloadChecked, (to) => listenerContext(to));
            },
        },

        push: (channel: string, message: unknown): void =>
        {
            const declared = wiring.known.get(plugin)?.definition.channels?.[channel];

            if (declared === undefined)
            {
                throw new KernelFault(
                    "UNDECLARED_CHANNEL",
                    `"${plugin}" pushed on "${channel}", which it does not declare. Add it to channels.`,
                    { plugin },
                );
            }

            if (wiring.sockets === undefined)
            {
                absentWiring(plugin, "socket server", "push", "sockets");
            }

            const scope = wiring.known.get(plugin)?.definition.scope;
            const pushScope = identity === undefined ? acting : identity.claims[scope?.claim ?? ""];

            if (declared.reach === "scope" && typeof pushScope !== "string")
            {
                throw new Refusal(403, "OUT_OF_SCOPE", "This request carries nothing to say whose rows it may reach.");
            }

            wiring.sockets.push({
                channel,
                message: declared.schema.parse(message),
                reach: declared.reach,
                requires: declared.requires ?? [],
                scope: declared.reach === "scope" ? (pushScope as string) : undefined,
                from: identity,
            });
        },

        hooks: {
            run: (hook, payload) =>
            {
                return wiring.points.run(plugin, hook, payload, (to) => contextFor(to));
            },
        },

        permissions,

        commands: {
            run: (command, input) =>
            {
                return wiring.run(command, input, identity);
            },

            later: (command, input, inSeconds) =>
            {
                if (wiring.schedule === undefined)
                {
                    absentWiring(plugin, "schedule", "commands.later", "schedule");
                }

                const owns = wiring.known.get(plugin)?.definition.commands ?? {};

                if (!Object.hasOwn(owns, command))
                {
                    throw new KernelFault(
                        "UNDECLARED_COMMAND",
                        `"${plugin}" scheduled "${command}", which it does not declare. A plugin schedules only its own commands.`,
                        { plugin },
                    );
                }

                wiring.schedule.save(openTransaction?.db, {
                    id: crypto.randomUUID(),
                    plugin,
                    command,
                    input,
                    at: wiring.now() + inSeconds * 1000,
                    attempts: 0,
                });
            },
        },

        owns: <Kept,>(kept: Kept): Kept =>
        {
            wiring.owned.set(plugin, kept);

            return kept;
        },

        owned: <Kept,>(): Kept | undefined =>
        {
            return wiring.owned.get(plugin) as Kept | undefined;
        },

        forScope: (claim: string): Context =>
        {
            if (identity !== undefined)
            {
                throw new KernelFault(
                    "OUT_OF_SCOPE",
                    `"${plugin}" called ctx.forScope where the caller has a scope of their own.`,
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

            return context(wiring, plugin, undefined, openTransaction, headers, claim, sent);
        },

        stamped: (table: string): Readonly<Record<string, string>> =>
        {
            const { column, tenant } = scopeFor(table);

            return { [column]: tenant };
        },

        scoped: <Condition,>(table: string): Condition =>
        {
            const { column, tenant } = scopeFor(table);

            return (wiring.scopeFilter === undefined
                ? absentWiring(plugin, "createScopeFilter", "scoped", "scopeFilter")
                : wiring.scopeFilter(table, column, tenant)) as Condition;
        },

        use: <Api,>(name: string): Api =>
        {
            const dependsOn = wiring.known.get(plugin)?.definition.dependsOn ?? [];

            if (name !== plugin && !dependsOn.includes(name))
            {
                throw new KernelFault(
                    "UNDECLARED_DEPENDENCY",
                    `"${plugin}" reached "${name}", which it does not depend on. Add "${name}" to dependsOn.`,
                    { plugin },
                );
            }

            return servicesOf(name) as Api;
        },
    };

    return ctx;
}
