import {
    S2S_NOTE_MAX,
    S2sAddressSchema,
    S2sContactNoticeSchema,
    S2sContactOriginSchema,
    S2sContactScopeSchema,
    type S2sContactScope,
    S2sContactStateSchema,
    S2sGrantsSchema,
    S2sRefSchema,
    SandboxIdentitySchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import { sandboxHostname } from "@intentic/sandbox-contract/ids/hostnames";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// THE CONTACTS (docs/architecture/messages.md, "Contacts"): every other sandbox this one knows, each pinned to the key
// its last verified document showed. A row keeps that whole document (the pinned key, its recovery fingerprint, its host
// and domains), the scope, the state, what this sandbox grants it and what it said it grants back, notices, and how it
// was made. Wake secrets are not here: they live in the auth root (s2s-secrets.ts). On the history volume, out of every
// turn's reach: an agent that could edit a row could pin a key of its choosing.

const ContactRowSchema = z.object({
    id: S2sRefSchema,
    address: S2sAddressSchema.describe("What it is addressed by: its host or an own domain, normalized."),
    // A name of this sandbox's own for it, a person's; absent, its document's.
    name: z.string().max(120).optional(),
    // The last document that verified and was trusted: its fingerprint is the pinned key.
    document: SandboxIdentitySchema,
    scope: S2sContactScopeSchema,
    state: S2sContactStateSchema,
    grants: S2sGrantsSchema,
    theirGrants: S2sGrantsSchema.optional(),
    notices: z.array(S2sContactNoticeSchema),
    origin: S2sContactOriginSchema,
    // What its request said, while one waits on a person here.
    note: z.string().max(S2S_NOTE_MAX).optional(),
    // A key-changed contact's new document, which Trust new key pins.
    pending: SandboxIdentitySchema.optional(),
    // The state it had when its key changed with no proof, which Trust new key gives back (a request still waits).
    heldFrom: S2sContactStateSchema.exclude(["key-changed", "blocked"]).optional(),
    // The sandbox id a party other than the contact vouched for (vouchedSandboxOf): what reports and drops route by.
    vouchedSandbox: z.string().min(1).max(100).optional(),
    // This sandbox's inbound wake secret was handed to it at some point: replaced when it leaves (contacts.ts rewake).
    wakeHeld: z.boolean().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastSeenAt: z.number().int().optional(),
});
export type ContactRow = z.infer<typeof ContactRowSchema>;

export const s2sContactsDocument = defineDocument({
    root: "history",
    path: "s2s/contacts.json",
    // Keys this sandbox pinned and the grants its owner gave: trust decisions, made again by the target's own owner, whose
    // sandbox has a key of its own that these contacts never saw.
    portability: "identity",
    note: "Add your contacts again from the Messages tab: the new sandbox has a key of its own.",
    schema: z.object({ contacts: z.array(ContactRowSchema) }),
});

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// Whether two scopes are the same: the sandbox, or the same person.
export const sameScope = (left: S2sContactScope, right: S2sContactScope): boolean =>
    left.kind === "sandbox" ? right.kind === "sandbox" : right.kind === "person" && sameEmail(left.person, right.person);

// The scope an envelope's `as` names: a person's route, or the sandbox itself.
export const scopeOfAs = (as: string | undefined): S2sContactScope => (as === undefined ? { kind: "sandbox" } : { kind: "person", person: as.toLowerCase() });

export interface ContactsStore {
    readonly list: () => Promise<readonly ContactRow[]>;
    readonly get: (id: string) => Promise<ContactRow | undefined>;
    // The contact an address speaks to this sandbox through, in a scope.
    readonly find: (address: string, scope: S2sContactScope) => Promise<ContactRow | undefined>;
    // Writes the row whole, adding it when its id is new.
    readonly put: (row: ContactRow) => Promise<ContactRow>;
    // Changes one row under the file's lock; undefined when the change answers undefined or there is no such row.
    readonly change: (id: string, change: (row: ContactRow) => ContactRow | undefined) => Promise<ContactRow | undefined>;
    readonly remove: (id: string) => Promise<ContactRow | undefined>;
}

export const fileContactsStore = (path: string): ContactsStore => {
    const file = openDocument(s2sContactsDocument, path, { fallback: () => ({ contacts: [] }), onUnreadable: "refuse" });
    const list = async (): Promise<readonly ContactRow[]> => (await file.read()).contacts;
    return {
        list,
        get: async (id) => (await list()).find((row) => row.id === id),
        find: async (address, scope) => (await list()).find((row) => row.address === address && sameScope(row.scope, scope)),
        put: async (row) => {
            await file.update((current) => ({ contacts: [...current.contacts.filter((held) => held.id !== row.id), row] }));
            return row;
        },
        change: async (id, change) => {
            let changed: ContactRow | undefined;
            await file.update((current) => {
                const row = current.contacts.find((held) => held.id === id);
                changed = row === undefined ? undefined : change(row);
                return changed === undefined ? current : { contacts: current.contacts.map((held) => (held.id === id && changed !== undefined ? changed : held)) };
            });
            return changed;
        },
        remove: async (id) => {
            let removed: ContactRow | undefined;
            await file.update((current) => {
                removed = current.contacts.find((held) => held.id === id);
                return removed === undefined ? current : { contacts: current.contacts.filter((held) => held.id !== id) };
            });
            return removed;
        },
    };
};

/**
 * The sandbox id a party other than the contact vouched for, or undefined when only the contact itself says which sandbox
 * it is (its document's `sandbox`, `name` and `theirGrants` are its own word). Recorded on the row (`vouchedSandbox`) by the
 * platform's pass (a first report's introduction, a route pairing's upgrade), the person's own editor pairing (both
 * documents read over their own sessions), or a link's upgrade bound to the peer the link was minted for; or read off the
 * platform's zone, when the address the contact's key was confirmed at is `sandbox-<id>.<zone>` and its document names that
 * very id, since only the platform answers there.
 */
export const vouchedSandboxOf = (row: Pick<ContactRow, "vouchedSandbox" | "address" | "document">, zone: string | undefined): string | undefined => {
    if (row.vouchedSandbox !== undefined) {
        return row.vouchedSandbox;
    }
    return zone !== undefined && zone !== "" && row.address === sandboxHostname(row.document.sandbox, zone) ? row.document.sandbox : undefined;
};

/** The accepted sandbox-scoped contact a sandbox's vouched id, its address, or a name names, when exactly that one does. */
export const sandboxContactNamed = async (store: Pick<ContactsStore, "list">, named: string, zone: string | undefined): Promise<ContactRow | undefined> => {
    const wanted = named.trim().toLowerCase();
    const matching = (await store.list()).filter(
        (row) =>
            row.state === "accepted" &&
            row.scope.kind === "sandbox" &&
            [row.name, row.document.name, row.address, vouchedSandboxOf(row, zone)].some((value) => value?.toLowerCase() === wanted),
    );
    return matching.length === 1 ? matching[0] : undefined;
};
