import type { CapabilityFacts } from "@intentic/extension-api";
import type { Snapshot } from "../core/snapshot.js";

// What the rail learns from the capability facts alone: which office cards are connected (one tile each). The config
// echo is secret-free; `provider` is the discriminator a card carries.

export type OfficeService = Snapshot["service"];

export interface OfficeCard {
    readonly id: string;
    readonly service: OfficeService;
}

const SERVICES: readonly OfficeService[] = ["ezd-rp", "e-doreczenia"];

const isService = (value: string | number | boolean | undefined): value is OfficeService => SERVICES.some((service) => service === value);

export const officeCards = (capabilities: readonly CapabilityFacts[]): OfficeCard[] =>
    capabilities.flatMap((capability) => {
        const provider = capability.config[`provider`];
        return capability.kind === `cli` && isService(provider) ? [{ id: capability.id, service: provider }] : [];
    });

// A notice still waiting to be collected reads as the most urgent row; an opened delivery as done.
export const deliveryTone = (row: Snapshot["deliveries"][number]): `warning` | `info` | `success` | `neutral` => {
    if (row.kind === `Stub`) {
        return `warning`;
    }
    if (!row.opened) {
        return `info`;
    }
    return row.saved === undefined ? `neutral` : `success`;
};

export const instant = (value: string | undefined): number | undefined => {
    const parsed = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
};
