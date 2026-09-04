import type { z } from "zod";

import type { Command, Context, Definition, Listener, Participant, Plugin, Route } from "./contract";
import * as names from "./names";

/**
 * Declares a plugin.
 *
 * The name is checked here rather than at start, so a typo names itself where
 * it was written instead of in a stack from somewhere else.
 *
 * `Db` is what `ctx.db` will be: the Drizzle handle over this plugin's own
 * tables. TypeScript cannot infer it, because the kernel never imports a
 * driver, so a plugin that queries names it:
 *
 *     export default definePlugin.over<ItemRows>()("items", { … });
 *
 * A plugin that never touches the database writes `definePlugin(name, …)` and
 * ignores all of this.
 */
export function definePlugin<Schema extends z.ZodType, Services = unknown, Db = unknown>(
    name: string,
    definition: Definition<Schema, Services, Db>,
): Plugin
{
    names.plugin(name);

    return { name, definition: definition as unknown as Definition };
}

/**
 * Declares a plugin whose `ctx.db` is typed.
 *
 * Curried because TypeScript takes a type argument list all or nothing: name
 * `Db` on `definePlugin` directly and you must also name `Schema`, which is
 * the config schema and infers perfectly well on its own.
 *
 * `Services` is named alongside `Db` when a route reads `ctx.services`: it is
 * inferred from what `services` returns, and a route above that key would
 * otherwise see `unknown`.
 */
definePlugin.over = <Db, Services = unknown>() =>
    <Schema extends z.ZodType>(
        name: string,
        definition: Definition<Schema, Services, Db>,
    ): Plugin =>
    {
        names.plugin(name);

        return { name, definition: definition as unknown as Definition };
    };

/**
 * Declares one route, with its input typed by its own schema.
 *
 * TypeScript settles a whole object literal's type before it looks inside an
 * array, so a route written inline hands its handler `unknown`. Declaring the
 * route through a function infers the schema first, and the handler reads its
 * fields.
 *
 *     defineRoute<ItemCtx>()({
 *         method: "GET",
 *         input: z.object({ id: z.uuid() }),
 *         handle: (given) => given.id,   // a string, no cast
 *     })
 */
export function defineRoute<Ctx = Context>()
{
    return <Input extends z.ZodType>(route: Route<Ctx, Input>): Route<Ctx, Input> =>
    {
        return route;
    };
}

/**
 * Declares one listener, with its payload typed by the event's own schema.
 *
 * Pass the schema the emitting plugin declared: the kernel parses against it
 * before delivering, so what arrives has already passed.
 *
 *     defineListener<ItemCtx>()(ItemMade.schema, {
 *         describe: "…",
 *         handle: (made) => made.id,   // a string, no cast
 *     })
 */
export function defineListener<Ctx = Context>()
{
    return <Payload extends z.ZodType>(
        _schema: Payload,
        listener: Listener<Ctx, z.infer<Payload>>,
    ): Listener<Ctx, z.infer<Payload>> =>
    {
        return listener;
    };
}

/** Declares one participant, with its payload typed by the hook's schema. */
export function defineParticipant<Ctx = Context>()
{
    return <Payload extends z.ZodType>(
        _schema: Payload,
        participant: Participant<Ctx, z.infer<Payload>>,
    ): Participant<Ctx, z.infer<Payload>> =>
    {
        return participant;
    };
}

/** Declares one command, with its input typed by its own schema. */
export function defineCommand<Ctx = Context>()
{
    return <Input extends z.ZodType>(command: Command<Ctx, Input>): Command<Ctx, Input> =>
    {
        return command;
    };
}
