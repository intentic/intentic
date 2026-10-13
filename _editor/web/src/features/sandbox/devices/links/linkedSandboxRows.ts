import type { CapabilitySummary } from "@intentic/sandbox-contract";
import { z } from "zod";

// One linked sandbox as the Devices board draws it, read off its link card's last status: answering (its terms in the
// detail), revoked over there (the card's `token` code), or not answering, which a sandbox that is off reads as and
// which is no broken link.

export type LinkedSandboxState = `online` | `revoked` | `quiet`;

export interface LinkedSandboxRow {
    readonly id: string;
    readonly name: string;
    readonly state: LinkedSandboxState;
    readonly tone: `success` | `danger` | `neutral`;
    readonly detail: string | undefined;
}

// The card echoes the far sandbox's name as config (link.handler.ts echo); a card that never learned one is named by its id.
const NameSchema = z.string().min(1);

const nameOf = (capability: CapabilitySummary): string => {
    const name = NameSchema.safeParse(capability.config[`name`]);
    return name.success ? name.data : capability.id;
};

export const linkedSandboxRowsOf = (capabilities: readonly CapabilitySummary[]): readonly LinkedSandboxRow[] =>
    capabilities
        .filter((capability) => capability.kind === `link`)
        .map((capability): LinkedSandboxRow => {
            const { state, code, detail } = capability.status;
            const linked: LinkedSandboxState = state === `active` ? `online` : code === `token` ? `revoked` : `quiet`;
            return {
                id: capability.id,
                name: nameOf(capability),
                state: linked,
                tone: linked === `online` ? `success` : linked === `revoked` ? `danger` : `neutral`,
                detail,
            };
        });
