import { join } from "node:path";
import type { OrgPolicy } from "@intentic/sandbox-contract/schemas/organisation";
import { SEAL_MODE_DEFAULT, type SealMode, SealModeSchema } from "@intentic/sandbox-contract/schemas/seal";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

/* THE HOUSE RULE FOR PRIVATE CONVERSATIONS (schemas/seal.ts), and each person's own default where it lets them choose.
 * Under the history root beside the roster, where no workspace write reaches: a turn must not be able to change who reads
 * whose conversations, any more than it may change who is on the roster. An organisation's policy fixes the rule over
 * whatever is held here (`houseOf`). */

const HouseSchema = z.object({
    mode: SealModeSchema.optional(),
    // Each person's own answer, by lowercased address: whether their new conversations start private.
    defaults: z.record(z.string(), z.boolean()).default({}),
});
export type HeldHouse = z.infer<typeof HouseSchema>;

export const sealHouseDocument = defineDocument({
    root: "history",
    path: "identity/seal-house.json",
    // Names people on this sandbox's own roster, which does not travel either.
    portability: "identity",
    note: "The house rule for private conversations is set again on the target, and each person answers their own default there.",
    schema: HouseSchema,
});

export interface SealHouseStore {
    readonly read: () => Promise<HeldHouse>;
    readonly setMode: (mode: SealMode) => Promise<void>;
    readonly setDefault: (email: string, sealed: boolean) => Promise<void>;
}

export const fileSealHouse = (historyRoot: string): SealHouseStore => {
    // Every handle on one path shares its write queue (queueOnFile), so a handle per call is enough.
    const file = () => openDocument(sealHouseDocument, join(historyRoot, sealHouseDocument.path), { fallback: (): HeldHouse => ({ defaults: {} }) });
    return {
        read: () => file().read(),
        setMode: async (mode) => {
            await file().update((current) => ({ ...current, mode }));
        },
        setDefault: async (email, sealed) => {
            await file().update((current) => ({ ...current, defaults: { ...current.defaults, [email.toLowerCase()]: sealed } }));
        },
    };
};

// The rule as it binds, and what an organisation holds of it.
export interface BindingHouse {
    readonly mode: SealMode;
    // An organisation fixed the rule, so nobody here changes it.
    readonly locked: boolean;
    // An organisation asks a second person to agree to any opening without asking.
    readonly twoPerson: boolean;
}

// An organisation's rule fixes it, else what the sandbox holds, else everyone reads everything.
export const houseOf = (held: HeldHouse, org: OrgPolicy | undefined): BindingHouse => {
    const fixed = org?.conversations?.mode;
    return { mode: fixed ?? held.mode ?? SEAL_MODE_DEFAULT, locked: fixed !== undefined, twoPerson: org?.conversations?.twoPerson === true };
};

// Whether a conversation this person starts now begins private. Under `private` it always does; under `chooses` as their
// own default says, which is shared until they answer; under `everyone` never.
export const startsPrivate = (mode: SealMode, held: HeldHouse, email: string | undefined): boolean =>
    mode === "private" || (mode === "chooses" && email !== undefined && held.defaults[email.toLowerCase()] === true);

// Whether every turn runs inside the sandbox jail (conversations/worktrees/turn-sandbox.ts) with the history volume out
// of its reach: while the house rule lets anything be private, and for as long as anything still is, since changing the
// rule never opens a sealed conversation and a turn that could read the history volume would open them all.
export const jailWanted = (mode: SealMode, sealed: number): boolean => mode !== "everyone" || sealed > 0;
