import { HubTargetSchema } from "@intentic/sandbox-contract/schemas/connection-hub";
import { KEYRING_NAME_RE } from "@intentic/sandbox-contract/schemas/keyring";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// WHAT THIS SANDBOX KNOWS OF THE CONNECTIONS HUB (schemas/connection-hub.ts): the entries it saved there, and the
// entries shared here it made into a card or account. Names and ids only: the values are the keyring copies'
// (secrets/device/keyring-stores.ts) and, once made, the cards' and accounts' own stores.

const EntryNameSchema = z.string().regex(KEYRING_NAME_RE);

// A connection sent to a computer's keyring from here.
const SavedSchema = z.object({
    target: HubTargetSchema,
    entry: EntryNameSchema,
    machine: z.string(),
    at: z.number(),
    pending: z.boolean(),
});

// A hub entry shared here, as last seen: the hash of its value (so an unchanged copy is not applied again), what it is
// here, whether this sandbox made that (and so takes it away when the entry stops being shared) or it was this
// sandbox's own all along, and why it could not be made, while it could not.
const SeenSchema = z.object({
    entry: EntryNameSchema,
    machine: z.string().optional(),
    hash: z.string(),
    target: HubTargetSchema.optional(),
    made: z.boolean(),
    failure: z.string().optional(),
    at: z.number(),
});
export type HubSeenRecord = z.infer<typeof SeenSchema>;

const HubFileSchema = z.object({ saved: z.array(SavedSchema), seen: z.array(SeenSchema) });
export type HubFile = z.infer<typeof HubFileSchema>;

// Under the auth root beside the keyring's own files: it names the entries this sandbox's keys open.
export const connectionHubDocument = defineDocument({ root: "auth", path: "connection-hub.json", schema: HubFileSchema });

export interface HubStore {
    readonly read: () => Promise<HubFile>;
    readonly update: (change: (current: HubFile) => HubFile) => Promise<HubFile>;
}

export const fileHubStore = (path: string): HubStore => {
    const file = openDocument(connectionHubDocument, path, { fallback: (): HubFile => ({ saved: [], seen: [] }), mode: 0o600 });
    return {
        read: () => file.read(),
        update: async (change) => {
            let next: HubFile = { saved: [], seen: [] };
            await file.update((current) => {
                next = change(current);
                return next;
            });
            return next;
        },
    };
};
