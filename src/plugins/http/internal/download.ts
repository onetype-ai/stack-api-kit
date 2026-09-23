/** A download sent as its chunks arrive; the caller leaving stops the source. */
export function chunkStream(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal | undefined): ReadableStream<Uint8Array>
{
    const iterator = chunks[Symbol.asyncIterator]();

    signal?.addEventListener("abort", () =>
    {
        void iterator.return?.();
    }, { once: true });

    return new ReadableStream<Uint8Array>({
        async pull(controller)
        {
            try
            {
                const next = await iterator.next();

                if (next.done === true)
                {
                    controller.close();

                    return;
                }

                controller.enqueue(next.value);
            }
            catch (cause)
            {
                controller.error(cause);
            }
        },

        cancel()
        {
            void iterator.return?.();
        },
    });
}
