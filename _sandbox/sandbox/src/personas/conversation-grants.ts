import { type ConversationGrant, ConversationGrantSchema, GrantShelfSchema, type GrantSubject } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// What a person allowed one conversation beyond its persona and its area, answered on a grant need's card
// (docs/architecture/needs.md). Beside the other credential policy under the auth root, off the agent-editable config:
// a grant an agent could write for itself would be no grant. Read as each turn of that conversation is planned
// (personas.ts widenPersona), so a grant reaches the next turn and never widens the one running. The one exception is
// `installs`, answered on an install card mid-turn and read live by the command gate (agent/providers/project-installs.ts):
// the yes is for the install that asked, and for every later one. `secrets` (a host guard card's "Allow <secret> anywhere
// in this conversation") and `everything` (any permission card's "Allow everything in this conversation") are read live
// too, by the host guard and the card registry.

export const conversationGrantsDocument = defineDocument({ root: "auth", path: "conversation-grants.json", schema: ConversationGrantSchema, granularity: "record" });

export type GrantItem = { readonly subject: Exclude<GrantSubject, "site"> | "secret"; readonly what: string };

export interface ConversationGrants {
    readonly all: () => Promise<Readonly<Record<string, ConversationGrant>>>;
    readonly of: (conversationId: string) => Promise<ConversationGrant | undefined>;
    readonly add: (conversationId: string, item: GrantItem, by: string | undefined) => Promise<void>;
    // Whether there was one to take back.
    readonly revoke: (conversationId: string, item: GrantItem) => Promise<boolean>;
    // "Allow installs for this conversation": its own dependency installs run without asking from here on.
    readonly allowInstalls: (conversationId: string, by: string | undefined) => Promise<void>;
    readonly installsAllowed: (conversationId: string) => Promise<boolean>;
    // Whether there was one to take back.
    readonly revokeInstalls: (conversationId: string) => Promise<boolean>;
    // "Allow everything in this conversation": every request an allow-once could settle goes without asking.
    readonly allowEverything: (conversationId: string, by: string | undefined) => Promise<void>;
    readonly everythingAllowed: (conversationId: string) => Promise<boolean>;
    // Whether there was one to take back.
    readonly revokeEverything: (conversationId: string) => Promise<boolean>;
    // A conversation that is gone takes its grants with it.
    readonly forget: (conversationId: string) => Promise<void>;
}

const FIELDS = { capability: "capabilities", folder: "folders", shelf: "shelves", secret: "secrets" } as const;
const field = (subject: GrantItem["subject"]): (typeof FIELDS)[GrantItem["subject"]] => FIELDS[subject];

const EMPTY = (now: number): ConversationGrant => ({
    capabilities: [],
    folders: [],
    shelves: [],
    installs: false,
    secrets: [],
    everything: false,
    updatedAt: now,
});

// A record with nothing left in it goes, so the Grants page never lists a conversation with no yes standing.
const nothingLeft = (grant: ConversationGrant): boolean =>
    grant.capabilities.length === 0 &&
    grant.folders.length === 0 &&
    grant.shelves.length === 0 &&
    grant.secrets.length === 0 &&
    !grant.installs &&
    !grant.everything;

// The two whole-conversation switches, set and taken back alike.
type Switch = "installs" | "everything";

const without = (current: GrantsByConversation, conversationId: string, next: ConversationGrant): GrantsByConversation => {
    if (!nothingLeft(next)) {
        return { ...current, [conversationId]: next };
    }
    const { [conversationId]: _dropped, ...rest } = current;
    return rest;
};

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
    const turnOn = async (conversationId: string, key: Switch, by: string | undefined): Promise<void> => {
        await file.update((current) => {
            const grant = current[conversationId] ?? EMPTY(now());
            return grant[key] ? current : { ...current, [conversationId]: { ...grant, [key]: true, updatedAt: now(), ...(by === undefined ? {} : { by }) } };
        });
    };
    const isOn = async (conversationId: string, key: Switch): Promise<boolean> => (await file.read())[conversationId]?.[key] === true;
    const turnOff = async (conversationId: string, key: Switch): Promise<boolean> => {
        let revoked = false;
        await file.update((current) => {
            const grant = current[conversationId];
            if (grant?.[key] !== true) {
                return current;
            }
            revoked = true;
            return without(current, conversationId, { ...grant, [key]: false, updatedAt: now() });
        });
        return revoked;
    };
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
                return without(current, conversationId, { ...grant, [field(item.subject)]: list.filter((entry) => entry !== item.what), updatedAt: now() });
            });
            return revoked;
        },
        allowInstalls: (conversationId, by) => turnOn(conversationId, "installs", by),
        installsAllowed: (conversationId) => isOn(conversationId, "installs"),
        revokeInstalls: (conversationId) => turnOff(conversationId, "installs"),
        allowEverything: (conversationId, by) => turnOn(conversationId, "everything", by),
        everythingAllowed: (conversationId) => isOn(conversationId, "everything"),
        revokeEverything: (conversationId) => turnOff(conversationId, "everything"),
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
