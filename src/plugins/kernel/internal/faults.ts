/**
 * What the kernel refuses.
 *
 * A closed union rather than a string: a caller branches on it, and a new
 * member is a compile error everywhere it is handled exhaustively.
 */
export type FaultCode =
    | "DUPLICATE_PLUGIN"
    | "UNKNOWN_DEPENDENCY"
    | "DEPENDENCY_CYCLE"
    | "INVALID_NAME"
    | "INVALID_CONFIG"
    | "INVALID_ROUTE"
    | "INVALID_PAYLOAD"
    | "WRONG_PAYLOAD"
    | "INVALID_OUTPUT"
    | "UNDECLARED_EVENT"
    | "UNDECLARED_HOOK"
    | "UNDECLARED_COMMAND"
    | "UNDECLARED_SCOPE"
    | "OUT_OF_SCOPE"
    | "UNDECLARED_PERMISSION"
    | "UNDECLARED_DEPENDENCY"
    | "UNDECLARED_HOST"
    | "DUPLICATE_ROUTE"
    | "DUPLICATE_EVENT"
    | "DUPLICATE_HOOK"
    | "DUPLICATE_COMMAND"
    | "DUPLICATE_PERMISSION"
    | "DUPLICATE_TABLE"
    | "UNAUTHENTICATED"
    | "PERMISSION_DENIED"
    | "RATE_LIMITED"
    | "NOT_STARTED";

type FaultDetail = {
    plugin?: string;
    detail?: Readonly<Record<string, unknown>>;
    cause?: unknown;
};

/**
 * A refusal, naming the plugin it came from.
 *
 * What makes a message worth the line is the plugin, the key, the owner, and
 * what to do about it. A code alone costs an hour.
 *
 * This is what the kernel says to whoever wrote the plugin. It is never what
 * a client is told: `internal/answer.ts` decides that, and it says less.
 */
export class KernelFault extends Error
{
    readonly code: FaultCode;

    readonly plugin: string | undefined;

    readonly detail: Readonly<Record<string, unknown>>;

    constructor(code: FaultCode, message: string, about: FaultDetail = {})
    {
        super(message, about.cause === undefined ? undefined : { cause: about.cause });

        this.name = "KernelFault";
        this.code = code;
        this.plugin = about.plugin;
        this.detail = about.detail ?? {};
    }

    override toString(): string
    {
        return this.plugin === undefined
            ? `${this.name} [${this.code}]: ${this.message}`
            : `${this.name} [${this.code}] in plugin "${this.plugin}": ${this.message}`;
    }
}
