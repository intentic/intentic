import { type ConversationGrant, ConversationGrantSchema, GrantShelfSchema, type GrantSubject } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// What a person allowed one conversation beyond its persona and its area, answered on a grant need's card
// (docs/architecture/needs.md). Beside the other credential policy under the auth root, off the agent-editable config:
// a grant an agent could write for itself would be no grant. Read as each turn of that conversation is planned
// (personas.ts widenPersona), so a grant reaches the next turn and never widens the one running.

export const conversationGrantsDocument = defineDocument({ root: "auth", path: "conversation-grants.json", schema: ConversationGrantSchema, granularity: "record" });

export type GrantItem = { readonly subject: Exclude<GrantSubject, "site">; readonly what: string };

export interface ConversationGrants {
    readonly all: () => Promise<Readonly<Record<string, ConversationGrant>>>;
    readonly of: (conversationId: string) => Promise<ConversationGrant | undefined>;
    readonly add: (conversationId: string, item: GrantItem, by: string | undefined) => Promise<void>;
    // Whether there was one to take back.
    readonly revoke: (conversationId: string, item: GrantItem) => Promise<boolean>;
    // A conversation that is gone takes its grants with it.
    readonly forget: (conversationId: string) => Promise<void>;
}

const field = (subject: GrantItem["subject"]): "capabilities" | "folders" | "shelves" =>
    subject === "capability" ? "capabilities" : subject === "folder" ? "folders" : "shelves";

const EMPTY = (now: number): ConversationGrant => ({ capabilities: [], folders: [], shelves: [], updatedAt: now });

type GrantsByConversation = Record<string, ConversationGrant>;

// What the grants are kept in: the auth-root document in the daemon, a plain object in memory for a suite.
interface GrantsFile {
    readonly read: () => Promise<GrantsByConversation>;
    readonly update: (change: (current: GrantsByConversation) => GrantsByConversation) => Promise<unknown>;
}

export const fileConversationGrants = (path: string, now: () => number = Date.now): ConversationGrants =>
    grantsOver(
        openDocument(conversationGrantsDocument, path, {
            fallback: (): GrantsByConversation => ({}),
            mode: 0o600,
            // A fresh file over an unreadable one would quietly take back every grant a person made.
            onUnreadable: "refuse",
        }),
        now,
    );

// Nothing kept past the process: a route suite's, which must not touch the machine to stand a turn up.
export const memoryConversationGrants = (now: () => number = Date.now): ConversationGrants => {
    let kept: GrantsByConversation = {};
    return grantsOver(
        {
            read: async () => kept,
            update: async (change) => {
                kept = change(kept);
            },
        },
        now,
    );
};

const grantsOver = (file: GrantsFile, now: () => number): ConversationGrants => {
    return {
        all: () => file.read(),
        of: async (conversationId) => (await file.read())[conversationId],
        add: async (conversationId, item, by) => {
            await file.update((current) => {
                const grant = current[conversationId] ?? EMPTY(now());
                const list: readonly string[] = grant[field(item.subject)];
                if (list.includes(item.what)) {
                    return current;
                }
                const next: ConversationGrant = {
                    ...grant,
                    ...(item.subject === "shelf"
                        ? { shelves: [...grant.shelves, GrantShelfSchema.parse(item.what)] }
                        : { [field(item.subject)]: [...list, item.what] }),
                    updatedAt: now(),
                    ...(by === undefined ? {} : { by }),
                };
                return { ...current, [conversationId]: next };
            });
        },
        revoke: async (conversationId, item) => {
            let revoked = false;
            await file.update((current) => {
                const grant = current[conversationId];
                const list: readonly string[] = grant?.[field(item.subject)] ?? [];
                if (grant === undefined || !list.includes(item.what)) {
                    return current;
                }
                revoked = true;
                const next = { ...grant, [field(item.subject)]: list.filter((entry) => entry !== item.what), updatedAt: now() };
                const empty = next.capabilities.length === 0 && next.folders.length === 0 && next.shelves.length === 0;
                if (empty) {
                    const { [conversationId]: _dropped, ...rest } = current;
                    return rest;
                }
                return { ...current, [conversationId]: next };
            });
            return revoked;
        },
        forget: async (conversationId) => {
            await file.update((current) => {
                if (!(conversationId in current)) {
                    return current;
                }
                const { [conversationId]: _dropped, ...rest } = current;
                return rest;
            });
        },
    };
};
