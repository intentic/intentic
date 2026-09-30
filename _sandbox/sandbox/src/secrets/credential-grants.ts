import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// A grant, keyed by conversation and subject, that a named person released a credential. Kept across restarts: a
// person's yes is never forgotten by the sandbox, only taken back by a person (Needs you → Grants), and a conversation
// that is gone takes its releases with it. Conversation-shaped: turn-shaped would re-ask every message,
// sandbox-shaped would leak across conversations. Read synchronously by the gates, so the file is mirrored in memory:
// loaded once at boot, every change written through as a change to what is stored.
// 2026-09-29: releases used to live in memory only, so a restart asked the approver again; rejected because a person's
// answer should outlast the process that heard it.

export interface CredentialGrant {
    // The verified email of whoever released it, off the reply's identity, never off anything the click said.
    readonly approvedBy: string;
    readonly at: number;
}

export interface CredentialGrants {
    // Settles once what was stored is in memory; a gate reading before then sees fewer releases, never more.
    readonly ready: Promise<void>;
    readonly grant: (conversationId: string, subject: string, grant: CredentialGrant) => void;
    readonly has: (conversationId: string, subject: string) => CredentialGrant | undefined;
    // Every release standing now, for the page where a person reviews and takes them back.
    readonly all: () => readonly { readonly conversationId: string; readonly subject: string; readonly grant: CredentialGrant }[];
    // Takes one release back; whether there was one. The conversation's next turn mounts without it.
    readonly revoke: (conversationId: string, subject: string) => boolean;
    // Drops everything a conversation was granted, so a reused conversation id inherits no live release.
    readonly forget: (conversationId: string) => void;
}

export const createCredentialGrants = (): CredentialGrants => {
    const byConversation = new Map<string, Map<string, CredentialGrant>>();
    return {
        ready: Promise.resolve(),
        grant: (conversationId, subject, grant) => {
            const existing = byConversation.get(conversationId);
            if (existing === undefined) {
                byConversation.set(conversationId, new Map([[subject, grant]]));
                return;
            }
            existing.set(subject, grant);
        },
        has: (conversationId, subject) => byConversation.get(conversationId)?.get(subject),
        all: () =>
            [...byConversation].flatMap(([conversationId, subjects]) => [...subjects].map(([subject, grant]) => ({ conversationId, subject, grant }))),
        revoke: (conversationId, subject) => {
            const subjects = byConversation.get(conversationId);
            const revoked = subjects?.delete(subject) === true;
            if (subjects !== undefined && subjects.size === 0) {
                byConversation.delete(conversationId);
            }
            return revoked;
        },
        forget: (conversationId) => {
            byConversation.delete(conversationId);
        },
    };
};

const CredentialReleasesSchema = z.record(z.string(), z.object({ approvedBy: z.string(), at: z.number() }));

// One conversation's releases, by subject, under the auth root beside the gates they answer.
export const credentialReleasesDocument = defineDocument({
    root: "auth",
    path: "credential-releases.json",
    schema: CredentialReleasesSchema,
    granularity: "record",
});

type Stored = Record<string, Record<string, CredentialGrant>>;

export const fileCredentialGrants = (path: string, warn: (error: unknown) => void): CredentialGrants => {
    const file = openDocument(credentialReleasesDocument, path, {
        fallback: (): Stored => ({}),
        mode: 0o600,
        // A fresh file over an unreadable one would quietly take back every release a person made.
        onUnreadable: "refuse",
    });
    const memory = createCredentialGrants();
    const ready = file.read().then(
        (stored) => {
            for (const [conversationId, subjects] of Object.entries(stored)) {
                for (const [subject, grant] of Object.entries(subjects)) {
                    // A release answered while this loaded is newer than what was stored; it stays.
                    if (memory.has(conversationId, subject) === undefined) {
                        memory.grant(conversationId, subject, grant);
                    }
                }
            }
        },
        (error: unknown) => warn(error),
    );
    // Written after the load and one after another, in the order they were made, so a change made before the load can't
    // be applied to a file not yet read, and a take-back never lands before the release it takes back.
    let written: Promise<unknown> = ready;
    const persist = (change: (current: Stored) => Stored): void => {
        written = written.then(() => file.update(change)).catch((error: unknown) => warn(error));
    };
    return {
        ...memory,
        ready,
        grant: (conversationId, subject, grant) => {
            memory.grant(conversationId, subject, grant);
            persist((current) => ({ ...current, [conversationId]: { ...current[conversationId], [subject]: grant } }));
        },
        revoke: (conversationId, subject) => {
            const revoked = memory.revoke(conversationId, subject);
            if (revoked) {
                persist((current) => {
                    const { [subject]: _taken, ...rest } = current[conversationId] ?? {};
                    const { [conversationId]: _all, ...others } = current;
                    return Object.keys(rest).length === 0 ? others : { ...others, [conversationId]: rest };
                });
            }
            return revoked;
        },
        forget: (conversationId) => {
            memory.forget(conversationId);
            persist((current) => {
                const { [conversationId]: _gone, ...rest } = current;
                return rest;
            });
        },
    };
};
