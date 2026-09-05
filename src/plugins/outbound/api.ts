import { dial, type DialerOptions, OutboundFault } from "./internal/dial";

export type Dialer = ReturnType<typeof dial>;

export { dial, OutboundFault };
export type { DialerOptions };

