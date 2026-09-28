// An in-memory grant, keyed by conversation and subject, that a named person released a credential. Not persisted: a
// restart ends the conversation the approver watched, so the next use asks again. Conversation-shaped: turn-shaped
// would re-ask every message, sandbox-shaped would leak across conversations.

export interface CredentialGrant {
    // The verified email of whoever released it, off the reply's identity, never off anything the click said.
    readonly approvedBy: string;
    readonly at: number;
}

export interface CredentialGrants {
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
