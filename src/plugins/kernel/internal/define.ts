import type { z } from "zod";

import type { Command, Context, Definition, Listener, Participant, Plugin, Route } from "./contract";
import * as names from "./names";

/** Declares a plugin. */
export function definePlugin<Schema extends z.ZodType, Services = unknown, Db = unknown>(
    name: string,
    definition: Definition<Schema, Services, Db>,
): Plugin
{
    names.pluginName(name);

    return { name, definition: definition as unknown as Definition };
}

/** Declares a plugin whose `ctx.db` is typed. */
definePlugin.over = <Db, Services = unknown>() =>
    <Schema extends z.ZodType>(
        name: string,
        definition: Definition<Schema, Services, Db>,
    ): Plugin =>
    {
        names.pluginName(name);

        return { name, definition: definition as unknown as Definition };
    };

/** Declares one route, with its input typed by its own schema. */
export function defineRoute<PluginContext = Context>()
{
    return <Input extends z.ZodType>(route: Route<PluginContext, Input>): Route<PluginContext, Input> =>
    {
        return route;
    };
}

/** Declares one listener, with its payload typed by the event's own schema. */
export function defineListener<PluginContext = Context>()
{
    return <Payload extends z.ZodType>(
        _schema: Payload,
        listener: Listener<PluginContext, z.infer<Payload>>,
    ): Listener<PluginContext, z.infer<Payload>> =>
    {
        return listener;
    };
}

/** Declares one participant, with its payload typed by the hook's schema. */
export function defineParticipant<PluginContext = Context>()
{
    return <Payload extends z.ZodType>(
        _schema: Payload,
        participant: Participant<PluginContext, z.infer<Payload>>,
    ): Participant<PluginContext, z.infer<Payload>> =>
    {
        return participant;
    };
}

/** Declares one command, with its input typed by its own schema. */
export function defineCommand<PluginContext = Context>()
{
    return <Input extends z.ZodType>(command: Command<PluginContext, Input>): Command<PluginContext, Input> =>
    {
        return command;
    };
}
