import type { ComposerDraft, DraftWrite, DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { ForkOfSchema, FreshOfSchema, QueuedServingSchema } from "@intentic/sandbox-contract/schemas/agent";
import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { opt } from "../../opt.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import type { AgentsRegistry } from "../registry/agents-registry.js";
import { actorOf } from "../../auth/principal.js";
import type { OrpcContext } from "../../app-env.js";

/* EVERY MEMBER'S UNSENT WORDS, at <historyRoot>/composer-drafts.json, one per person and conversation: the one record a
   composer's words live in (schemas/composer-drafts.ts says why it is not the browser's). A browser holds an optimistic
   copy and writes it here naming the revision it edited from, so a window or device holding older words never writes
   over newer ones unseen. Sending clears the draft in the same step that takes the message (agent.routes.ts `run`), and
   only the revision that was sent, so the words go exactly once and anything typed after survives. Outside /work, where
   no agent reads, and never on a card: nothing here leaves for a model until the person sends it. */

const StoredDraftSchema = z.object({
    text: z.string(),
    attachments: z.array(z.string()).optional(),
    serves: QueuedServingSchema.optional(),
    forkOf: ForkOfSchema.optional(),
    freshOf: FreshOfSchema.optional(),
    since: z.number(),
    revision: z.number().int().positive(),
});
type StoredDraft = z.infer<typeof StoredDraftSchema>;

const ComposerDraftsFileSchema = z.object({
    // The last revision handed out, across everyone's drafts: a revision is never reused, so a stale one never matches.
    revision: z.number().int().nonnegative(),
    // By person (who wrote them, as authorization verified them), then by conversation.
    people: z.record(z.string(), z.record(z.string(), StoredDraftSchema)),
});
export type DraftsFile = z.infer<typeof ComposerDraftsFileSchema>;

// Each member's unsent composer words, per conversation: what they were writing when the workspace was packed, so it
// opens with the same composers. Carried like the conversations.
export const composerDraftsDocument = defineDocument({
    root: "history",
    path: "composer-drafts.json",
    portability: "carry",
    schema: ComposerDraftsFileSchema,
});

/** What a write or a clear did: its answer, and whether the drafts moved at all. */
export interface DraftChange {
    readonly answer: DraftWritten;
    readonly changed: boolean;
}

/** One step over the file: the file it leaves (the same object when nothing moved) and what it did. */
export interface DraftStep {
    readonly file: DraftsFile;
    readonly change: DraftChange;
}

const asDraft = (conversationId: string, stored: StoredDraft): ComposerDraft => ({ conversationId, ...stored });

const answerOf = (conversationId: string, stored: StoredDraft | undefined, conflict: boolean): DraftWritten => {
    let answer: DraftWritten = {};
    if (stored !== undefined) {
        answer = { draft: asDraft(conversationId, stored) };
    }
    return conflict ? { ...answer, conflict: true } : answer;
};

const withPerson = (file: DraftsFile, person: string, drafts: Readonly<Record<string, StoredDraft>>): DraftsFile => {
    const { [person]: _replaced, ...others } = file.people;
    return { ...file, people: Object.keys(drafts).length === 0 ? others : { ...others, [person]: { ...drafts } } };
};

const without = (drafts: Readonly<Record<string, StoredDraft>>, conversationId: string): Record<string, StoredDraft> => {
    const { [conversationId]: _gone, ...kept } = drafts;
    return kept;
};

/** Removes a person's draft, only while it is `revision` when one is named. Pure; the file is unchanged on a conflict or a miss. */
export const clearIn = (file: DraftsFile, person: string, conversationId: string, revision: number | undefined): DraftStep => {
    const mine = file.people[person] ?? {};
    const current = mine[conversationId];
    if (current === undefined) {
        return { file, change: { answer: {}, changed: false } };
    }
    if (revision !== undefined && current.revision !== revision) {
        return { file, change: { answer: answerOf(conversationId, current, true), changed: false } };
    }
    return { file: withPerson(file, person, without(mine, conversationId)), change: { answer: {}, changed: true } };
};

// Nothing left to send: no words beyond whitespace and no file.
const holdsNothing = (write: Pick<DraftWrite, "text" | "attachments">): boolean => write.text.trim() === "" && (write.attachments?.length ?? 0) === 0;

/**
 * Writes a person's draft, unless it moved past `base` since that writer read it: then nothing is written and the newer
 * draft comes back as a conflict. A draft gone since `base` (sent, or cleared elsewhere) is a conflict too, answered with
 * none, so words that were already sent never come back as a draft. Empty words clear it. Pure.
 */
export const writeIn = (file: DraftsFile, person: string, write: DraftWrite, now: number): DraftStep => {
    const mine = file.people[person] ?? {};
    const current = mine[write.id];
    if (write.base !== undefined && current?.revision !== write.base) {
        return { file, change: { answer: answerOf(write.id, current, true), changed: false } };
    }
    if (holdsNothing(write)) {
        return clearIn(file, person, write.id, write.base);
    }
    const revision = file.revision + 1;
    const stored: StoredDraft = {
        text: write.text,
        ...opt("attachments", write.attachments === undefined || write.attachments.length === 0 ? undefined : [...write.attachments]),
        ...opt("serves", write.serves),
        ...opt("forkOf", write.forkOf),
        ...opt("freshOf", write.freshOf),
        since: current?.since ?? write.since ?? now,
        revision,
    };
    return { file: withPerson({ ...file, revision }, person, { ...mine, [write.id]: stored }), change: { answer: answerOf(write.id, stored, false), changed: true } };
};

/** One person's drafts, newest first. */
export const draftsOf = (file: DraftsFile, person: string): readonly ComposerDraft[] =>
    Object.entries(file.people[person] ?? {})
        .map(([conversationId, stored]) => asDraft(conversationId, stored))
        .toSorted((a, b) => b.revision - a.revision);

/** Since when anybody has held a draft for the conversation: the earliest of everyone's, undefined when nobody does. */
export const heldSinceIn = (file: DraftsFile, conversationId: string): number | undefined => {
    const since = Object.values(file.people).flatMap((drafts) => {
        const draft = drafts[conversationId];
        return draft === undefined ? [] : [draft.since];
    });
    return since.length === 0 ? undefined : Math.min(...since);
};

// Whose drafts a request reads and writes: the member authorization verified, or the program a control token names. A
// daemon with nobody signed in (auth off on a developer's machine) has one person, and its drafts are that person's.
const NOBODY_SIGNED_IN = "-";
export const draftOwnerOf = (context: Pick<OrpcContext, "identity" | "principal">): string => actorOf(context.identity, context.principal) ?? NOBODY_SIGNED_IN;

/**
 * The answer to a send, once the draft its words were sent from has gone with the message the sandbox just took: only
 * that revision, so words typed since in another window stay, and a resend under the same id finds it already gone.
 */
export const answeredAfterDraft = async <T>(
    drafts: Pick<ComposerDrafts, "clear">,
    context: Pick<OrpcContext, "identity" | "principal">,
    sent: { readonly conversationId: string; readonly draft: number | undefined },
    answer: T,
): Promise<T> => {
    if (sent.draft !== undefined) {
        await drafts.clear(draftOwnerOf(context), sent.conversationId, sent.draft);
    }
    return answer;
};

export interface ComposerDrafts {
    // With the newest revision handed out as it was read, so a reader can tell "gone" from "written after this read".
    readonly list: (person: string) => Promise<{ readonly drafts: readonly ComposerDraft[]; readonly revision: number }>;
    readonly write: (person: string, write: DraftWrite) => Promise<DraftWritten>;
    readonly clear: (person: string, conversationId: string, revision?: number) => Promise<DraftWritten>;
    /** Since when anybody has held a draft for the conversation. */
    readonly heldSince: (conversationId: string) => Promise<number | undefined>;
}

/**
 * The store, telling `moved` each conversation whose drafts changed, after the write is on disk: the card's `unsentAt`
 * and the `drafts` push both follow from that one call.
 */
const fileComposerDrafts = (path: string, moved: (conversationId: string) => void, now: () => number = Date.now): ComposerDrafts => {
    const file = openDocument(composerDraftsDocument, path, { fallback: (): DraftsFile => ({ revision: 0, people: {} }), mode: 0o600 });
    const apply = async (conversationId: string, step: (current: DraftsFile) => DraftStep): Promise<DraftWritten> => {
        let change: DraftChange = { answer: {}, changed: false };
        await file.update((current) => {
            const next = step(current);
            change = next.change;
            return next.file;
        });
        if (change.changed) {
            moved(conversationId);
        }
        return change.answer;
    };
    return {
        list: async (person) => {
            const current = await file.read();
            return { drafts: draftsOf(current, person), revision: current.revision };
        },
        write: (person, write) => apply(write.id, (current) => writeIn(current, person, write, now())),
        clear: (person, conversationId, revision) => apply(conversationId, (current) => clearIn(current, person, conversationId, revision)),
        heldSince: async (conversationId) => heldSinceIn(await file.read(), conversationId),
    };
};

/**
 * The store as the daemon runs it: every move is pushed as the `drafts` domain (no words, no names, so every window
 * may hear it) and becomes the conversation's `unsentAt`, so the idle archive never files away words somebody is writing.
 */
export const registryDrafts = (
    historyRoot: string,
    agents: Pick<AgentsRegistry, "entry" | "setUnsent">,
    warn: (error: Error, conversationId: string) => void,
): ComposerDrafts => {
    const drafts: ComposerDrafts = fileComposerDrafts(join(historyRoot, composerDraftsDocument.path), (conversationId) => {
        publishRuntimeChange("drafts");
        void drafts
            .heldSince(conversationId)
            .then((since) => (agents.entry(conversationId)?.social.unsentAt === since ? undefined : agents.setUnsent(conversationId, since ?? null)))
            .catch((error: Error) => warn(error, conversationId));
    });
    return drafts;
};
