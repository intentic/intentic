// The words the vendor loops' watchdog says a cap reached mid-work with (runtimes/decorators/turn-watchdog.ts expiry),
// which tell it from one reached after the loop went quiet (cap-continuation.ts). A module of its own with no imports, on
// the agent side, since the watchdog may import from this layer and not the other way.
export const CAP_WHILE_ACTIVE = "cap while still active";
