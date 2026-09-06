import type { Hook, Participation } from "./contract";
import { KernelFault } from "./faults";

/** What the timer answers with. An object, so no participant can return it. */
const LATE = Symbol("late");

type HookOwner = {
    owner: string;
    hook: Hook;
};

type ParticipantOwner<Context> = {
    plugin: string;
    participant: Participation<Context>;
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
    const declared = new Map<string, HookOwner>();
    const participants = new Map<string, ParticipantOwner<Context>[]>();

    return {
        declare: (owner: string, name: string, hook: Hook): void =>
        {
            declared.set(name, { owner, hook });
        },

        participate: (plugin: string, name: string, participant: Participation<Context>): void =>
        {
            participants.set(name, [...(participants.get(name) ?? []), { plugin, participant }]);
        },

        run: async (plugin: string, name: string, payload: unknown, ctx: (plugin: string) => Context): Promise<string | undefined> =>
        {
            const point = declared.get(name);

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

            for (const entry of participants.get(name) ?? [])
            {
                let timer: ReturnType<typeof setTimeout> | undefined;

                try
                {
                    const answered = entry.participant.handle(parsed.data as never, ctx(entry.plugin));

                    const refusal = await Promise.race([
                        answered,
                        new Promise<typeof LATE>((done) =>
                        {
                            timer = setTimeout(() => done(LATE), patience);
                        }),
                    ]);

                    if (refusal === LATE)
                    {
                        return `"${entry.plugin}" did not answer in ${String(patience)}ms.`;
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
                    return `"${entry.plugin}" refused: ${cause instanceof Error ? cause.message : String(cause)}`;
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
