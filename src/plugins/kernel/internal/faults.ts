/** What the kernel refuses. */
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
    | "UNDECLARED_CHANNEL"
    | "UNDECLARED_EVENT"
    | "UNHEARD_EVENT"
    | "UNDECLARED_HOOK"
    | "UNDECLARED_COMMAND"
    | "UNDECLARED_SCOPE"
    | "UNSCOPED_CALLER"
    | "UNCLAIMED_SCOPE"
    | "OUT_OF_SCOPE"
    | "UNDECLARED_PERMISSION"
    | "UNDECLARED_DEPENDENCY"
    | "UNDECLARED_HOST"
    | "DUPLICATE_ROUTE"
    | "DUPLICATE_CHANNEL"
    | "DUPLICATE_EVENT"
    | "DUPLICATE_HOOK"
    | "DUPLICATE_COMMAND"
    | "DUPLICATE_PERMISSION"
    | "DUPLICATE_GRANTS"
    | "UNGRANTABLE_PERMISSION"
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

/** A refusal, naming the plugin it came from. */
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
