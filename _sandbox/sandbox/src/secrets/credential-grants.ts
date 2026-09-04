/* WHAT A "REST OF THE CONVERSATION" RELEASE ACTUALLY IS: a note in memory, keyed by conversation and subject,
 * that one named person said yes.
 *
 * DELIBERATELY NOT PERSISTED, and this is the decision the module exists to record. A grant is consent given
 * in a conversation the approver was watching; a daemon restart ends every turn that was running, drops every
 * parked card and forgets every session, and a release that outlived all of that would be consent nobody is
 * present for any more — the owner's click on Tuesday quietly covering a scheduled turn on Thursday. So a
 * restart forgets, and the next use asks again. The cost is one extra card after a restart, which is the
 * cheapest possible thing to be wrong about in this direction.
 *
 * WHY CONVERSATION-SHAPED rather than turn-shaped. A per-use gate is answered at the exit and never comes
 * here; what comes here is the gate whose owner said "for the rest of this conversation", and a conversation
 * is the unit the PERSON was thinking in when they said it. Turn-shaped would re-ask on every follow-up
 * message, which is the same click over and over and trains people to stop reading the card; sandbox-shaped
 * would let a release leak into a conversation the approver never saw.
 *
 * SESSION-SHAPED CREDENTIALS CAN ONLY BE THIS. A browser profile that is mounted, a connector's env that is
 * exported, an MCP server that is running — none of them can be handed over "for one use", because the use is
 * a whole turn's worth of access to something already signed in. The route that writes the policy forces
 * those to `conversation` (secrets.routes.ts) rather than leaving a scope that cannot be honoured on offer. */

export interface CredentialGrant {
    // The verified email of whoever released it, off the reply's identity, never off anything the click said.
    readonly approvedBy: string;
    readonly at: number;
}

export interface CredentialGrants {
    readonly grant: (conversationId: string, subject: string, grant: CredentialGrant) => void;
    readonly has: (conversationId: string, subject: string) => CredentialGrant | undefined;
    // Drop everything a conversation was granted, called when it is archived or purged: a conversation nobody
    // can reopen must not leave a live release behind for a conversation id that gets reused.
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
        forget: (conversationId) => {
            byConversation.delete(conversationId);
        },
    };
};
