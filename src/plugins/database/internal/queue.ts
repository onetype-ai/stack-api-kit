/**
 * Runs work one at a time.
 *
 * SQLite gives us one connection, and a transaction lives on the connection
 * rather than on the call that opened it. So an async transaction that awaits
 * anything leaves the connection inside a transaction while other work runs:
 * a second request's write lands in someone else's transaction and is lost to
 * their rollback, and a second BEGIN throws outright.
 *
 * Queueing is what makes `tx` mean what it says. It costs throughput, which
 * is the trade SQLite already made for us: one writer, whatever we do.
 */
export function queue()
{
    let last: Promise<unknown> = Promise.resolve();

    return {
        run: <Result,>(work: () => Promise<Result>): Promise<Result> =>
        {
            const mine = last.then(work, work);

            // The chain must not stop at a failure, and must not keep the
            // rejection alive: whoever asked already holds it.
            last = mine.catch(() => undefined);

            return mine;
        },
    };
}
