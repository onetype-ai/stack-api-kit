import { dial, type Dialing, OutboundFault } from "./internal/dial";

export type Dialer = ReturnType<typeof dial>;

export { dial, OutboundFault };
export type { Dialing };

