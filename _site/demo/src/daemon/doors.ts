import type { FixtureRouter } from "@intentic/contract-serve";

// One contract group's handlers, typed by the contract: each group of the fixture daemon lives in a file of its own
// (`<area>/<group>.handler.ts`, beside the stores of that area), so procedures.ts only assembles them.
export type Doors<G extends keyof FixtureRouter> = NonNullable<FixtureRouter[G]>;

/** A mutation with nothing to report: do it, then answer the daemon's own `{ ok: true }`. */
export const okAfter = (write: () => void) => {
    write();
    return { ok: true as const };
};
