import type { Doors } from "../doors";

// The demo sandbox is a person's own: no organisation holds any section of its hub (docs/architecture/organisations.md).
export const orgDoors = {
    policy: () => ({ bound: false as const }),
} satisfies Doors<`org`>;
