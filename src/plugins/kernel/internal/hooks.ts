import type { Hook, Joined } from "./contract";
import { KernelFault } from "./faults";

/** What the timer answers with. An object, so no participant can return it. */
const LATE = Symbol("late");

type Opened = {
    owner: string;
    hook: Hook;
};

type Participating<Context> = {
    plugin: string;
    participant: Joined<Context>;
};

/**
 * How long a participant has to answer.
 *
 * A participant that throws is already a refusal; one that never answers is
 * the same thing arriving more slowly, and without this it holds the request
 * open for as long as the process lives.
 */
const PATIENCE = 5000;

export function hooks<Context>(patience: number = PATIENCE)
{
    const opened = new Map<string, Opened>();
    const joined = new Map<string, Participating<Context>[]>();

    return {
        declare: (owner: string, name: string, hook: Hook): void =>
        {
            opened.set(name, { owner, hook });
        },

        participate: (plugin: string, name: string, participant: Joined<Context>): void =>
        {
            joined.set(name, [...(joined.get(name) ?? []), { plugin, participant }]);
        },

        run: async (plugin: string, name: string, payload: unknown, ctx: (plugin: string) => Context): Promise<string | undefined> =>
        {
            const point = opened.get(name);

            if (point === undefined)
            {
                throw new KernelFault("UNDECLARED_HOOK", `"${plugin}" ran "${name}", which no plugin declares. Add it to hooks.`, { plugin });
            }

            if (point.owner !== plugin)
            {
                throw new KernelFault("UNDECLARED_HOOK", `"${plugin}" ran "${name}", which belongs to "${point.owner}". A plugin runs only the hooks it owns.`, { plugin, detail: { owner: point.owner } });
            }

            const parsed = point.hook.schema.safeParse(payload);

            if (!parsed.success)
            {
                throw new KernelFault("WRONG_PAYLOAD", `The payload for "${name}" does not match its schema: ${parsed.error.issues[0]?.message ?? "it was rejected"}.`, { plugin });
            }

            for (const participant of joined.get(name) ?? [])
            {
                let timer: ReturnType<typeof setTimeout> | undefined;

                try
                {
                    const answered = participant.participant.handle(parsed.data as never, ctx(participant.plugin));

                    const refusal = await Promise.race([
                        answered,
                        new Promise<typeof LATE>((keep) =>
                        {
                            timer = setTimeout(() => keep(LATE), patience);
                        }),
                    ]);

                    if (refusal === LATE)
                    {
                        return `"${participant.plugin}" did not answer in ${String(patience)}ms.`;
                    }

                    if (refusal !== undefined)
                    {
                        return refusal;
                    }
                }
                catch (cause)
                {
                    // A participant whose check crashed has not agreed to
                    // anything, so a throw is a refusal, never consent.
                    return `"${participant.plugin}" refused: ${cause instanceof Error ? cause.message : String(cause)}`;
                }
                finally
                {
                    clearTimeout(timer);
                }
            }

            return undefined;
        },
    };
}
