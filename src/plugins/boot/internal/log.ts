import type { Logger } from "../../kernel/api";

/** How loud a line is, and how loud a logger listens. */
export type Level = "debug" | "info" | "warn" | "error";

type Write = (level: Level, message: string, about?: Readonly<Record<string, unknown>>) => void;

const severity: Readonly<Record<Level, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Every level, in order, for a caller reading one from configuration. */
export const LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly Level[];

/** One JSON object a line, written to stdout; a line never throws while being written. */
export const Log = {
    levels: LEVELS,
    severity,

    line: (level: Level, message: string, about?: Readonly<Record<string, unknown>>): string =>
    {
        const record = { ...about, at: new Date().toISOString(), level, line: message };

        try
        {
            return `${JSON.stringify(record, Log.forJson)}\n`;
        }
        catch
        {
            return `${JSON.stringify({ at: record.at, level, line: message, about: "unreadable" })}\n`;
        }
    },

    forJson: (_key: string, value: unknown): unknown =>
    {
        if (value instanceof Error)
        {
            return { message: value.message, stack: value.stack };
        }

        return typeof value === "bigint" ? value.toString() : value;
    },

    forLevel: (level: Level = "info"): Logger =>
    {
        const write: Write = (writeLevel, message, about) =>
        {
            if ((severity[writeLevel] ?? 0) >= (severity[level] ?? 0))
            {
                process.stdout.write(Log.line(writeLevel, message, about));
            }
        };

        return {
            debug: (message, about) =>
            {
                write("debug", message, about);
            },
            info: (message, about) =>
            {
                write("info", message, about);
            },
            warn: (message, about) =>
            {
                write("warn", message, about);
            },
            error: (message, about) =>
            {
                write("error", message, about);
            },
        };
    },
};
