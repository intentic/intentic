import {
    PRIVACY_LEAKS_MAX,
    PRIVACY_PROPOSALS_MAX,
    type PrivacyLeak,
    PrivacyLeakSchema,
    type PrivacyProposal,
    PrivacyProposalSchema,
} from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import type { JsonFile } from "../../store/json-file.js";
import { openDocument } from "../../store/open-document.js";

// The leaks reported or suspected, the hardening proposals waiting for the owner, and the session last started on them
// (schemas/privacy-leaks.ts). A leak holds a value the shield let through, and the text around it, so the file sits with
// the vault (mode 0600, off the workspace, encrypted at rest) and nothing the agent can edit holds it.

const LeakSessionSchema = z.object({ conversationId: z.string(), at: z.string() });

export const privacyLeaksDocument = defineDocument({
    root: "auth",
    path: "privacy-leaks.json",
    schema: z.object({
        // Each kind's next number. Kept rather than derived, so an id a proposal names is never given to another leak.
        next: z.object({ leak: z.number().int().positive().default(1), proposal: z.number().int().positive().default(1) }).default({ leak: 1, proposal: 1 }),
        leaks: z.array(PrivacyLeakSchema).default([]),
        proposals: z.array(PrivacyProposalSchema).default([]),
        session: LeakSessionSchema.optional(),
    }),
});

export type LeaksValue = z.infer<typeof privacyLeaksDocument.schema>;

export interface PrivacyLeakStore {
    readonly read: () => Promise<LeaksValue>;
    // Adds leaks, each given the next id, and answers them as kept. Past the cap the oldest dismissed leaks go first,
    // then the oldest suspected ones; a confirmed leak is only ever dropped by the owner.
    readonly add: (leaks: readonly Omit<PrivacyLeak, "id">[]) => Promise<PrivacyLeak[]>;
    readonly judge: (id: string, state: PrivacyLeak["state"]) => Promise<PrivacyLeak | undefined>;
    readonly propose: (proposal: Omit<PrivacyProposal, "id">) => Promise<PrivacyProposal>;
    // Takes a proposal off the list, answering it; undefined when there is none by that id.
    readonly takeProposal: (id: string) => Promise<PrivacyProposal | undefined>;
    readonly noteSession: (conversationId: string, at: string) => Promise<void>;
}

const EMPTY = (): LeaksValue => ({ next: { leak: 1, proposal: 1 }, leaks: [], proposals: [] });

// Which leak goes first once the list is full: dismissed, then suspected, oldest first; never a confirmed one.
const trimmed = (leaks: readonly PrivacyLeak[]): PrivacyLeak[] => {
    let kept = [...leaks];
    for (const state of ["dismissed", "suspected"] as const) {
        while (kept.length > PRIVACY_LEAKS_MAX) {
            const oldest = kept.findIndex((leak) => leak.state === state);
            if (oldest === -1) {
                break;
            }
            kept = kept.toSpliced(oldest, 1);
        }
    }
    return kept;
};

const createPrivacyLeakStore = (file: JsonFile<LeaksValue>): PrivacyLeakStore => ({
    read: file.read,
    add: async (leaks) => {
        let added: PrivacyLeak[] = [];
        await file.update((current) => {
            added = leaks.map((leak, index) => ({ ...leak, id: `L${String(current.next.leak + index)}` }));
            return {
                ...current,
                next: { ...current.next, leak: current.next.leak + leaks.length },
                leaks: trimmed([...current.leaks, ...added]),
            };
        });
        return added;
    },
    judge: async (id, state) => {
        let judged: PrivacyLeak | undefined;
        await file.update((current) => {
            const index = current.leaks.findIndex((leak) => leak.id === id);
            const leak = current.leaks[index];
            if (leak === undefined) {
                return current;
            }
            judged = { ...leak, state };
            return { ...current, leaks: current.leaks.with(index, judged) };
        });
        return judged;
    },
    propose: async (proposal) => {
        let kept: PrivacyProposal | undefined;
        await file.update((current) => {
            kept = { ...proposal, id: `P${String(current.next.proposal)}` };
            return {
                ...current,
                next: { ...current.next, proposal: current.next.proposal + 1 },
                // The newest are what someone is waiting on; the oldest unread one goes past the cap.
                proposals: [...current.proposals, kept].slice(-PRIVACY_PROPOSALS_MAX),
            };
        });
        // SAFETY of the non-null: the update above always assigns it before it returns.
        return kept ?? { ...proposal, id: "P0" };
    },
    takeProposal: async (id) => {
        let taken: PrivacyProposal | undefined;
        await file.update((current) => {
            taken = current.proposals.find((proposal) => proposal.id === id);
            return taken === undefined ? current : { ...current, proposals: current.proposals.filter((proposal) => proposal.id !== id) };
        });
        return taken;
    },
    noteSession: async (conversationId, at) => {
        await file.update((current) => ({ ...current, session: { conversationId, at } }));
    },
});

export const filePrivacyLeaks = (path: string): PrivacyLeakStore =>
    createPrivacyLeakStore(
        openDocument(privacyLeaksDocument, path, {
            fallback: EMPTY,
            mode: 0o600,
            onUnreadable: "refuse",
            atRestPurpose: privacyLeaksDocument.path,
        }),
    );

// In memory, for the route suites and the tests.
export const memoryPrivacyLeaks = (initial: LeaksValue = EMPTY()): PrivacyLeakStore => {
    let value = initial;
    return createPrivacyLeakStore({
        read: async () => value,
        state: async () => ({ value, unreadable: false }),
        update: async (change) => {
            value = change(value);
            return value;
        },
    });
};
