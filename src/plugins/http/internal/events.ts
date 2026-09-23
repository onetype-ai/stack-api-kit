/** One frame a streamed route yields: an event with its SSE fields, or a raw data line. */
type Frame = { data?: unknown; event?: string | undefined; id?: string | undefined; raw?: string };

/** How often a quiet stream says it is alive, so a proxy does not take it for a dead one. */
const KEEPALIVE_MS = 15_000;

/** A streamed route as Server-Sent Events: one frame an event, a comment every 15 s, and the handler's iterator closed when the caller goes. */
export function eventStream(events: AsyncIterable<Frame>, signal: AbortSignal | undefined): ReadableStream<Uint8Array>
{
    const encoder = new TextEncoder();
    const iterator = events[Symbol.asyncIterator]();

    let beat: ReturnType<typeof setInterval> | undefined;

    const stop = (): void =>
    {
        clearInterval(beat);
        void iterator.return?.();
    };

    return new ReadableStream<Uint8Array>({
        start(controller)
        {
            beat = setInterval(() =>
            {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
            }, KEEPALIVE_MS);

            signal?.addEventListener("abort", stop, { once: true });
        },

        async pull(controller)
        {
            const next = await iterator.next();

            if (next.done === true)
            {
                clearInterval(beat);
                controller.close();

                return;
            }

            const frame = next.value;
            const lines = typeof frame.raw === "string"
                ? [`data: ${frame.raw}`]
                : [
                    ...(frame.event === undefined ? [] : [`event: ${frame.event}`]),
                    ...(frame.id === undefined ? [] : [`id: ${frame.id}`]),
                    `data: ${JSON.stringify(frame.data)}`,
                ];

            controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
        },

        cancel: stop,
    });
}
