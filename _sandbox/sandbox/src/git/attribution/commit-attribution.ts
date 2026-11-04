import { join } from "node:path";
import { z } from "zod";
import type { CommitAttribution, CommitIdentityState, GitPerson } from "@intentic/sandbox-contract/schemas/settings";
import type { GitCommit } from "@intentic/sandbox-contract/schemas/git/git-history";
import type { Services } from "../../composition.js";
import { AGENT_COMMIT_EMAIL, AGENT_COMMIT_NAME, AGENT_GIT_AUTHOR, attributionOf, type Attribution, type CommitSigner, CONVERSATION_TRAILER, UNATTRIBUTED } from "../../git-identity.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { opt } from "../../opt.js";

// WHO A COMMIT NAMES. The sandbox's `commitAttribution` says how much of a person goes into history; this module finds
// the person. A request names the person who sent it, a conversation the person who answers for it now (its owner moves
// with a reassignment), and either names them only by the commit name and address they set here themselves, never by
// the address they signed in with: a pushed commit publishes it for good.

// Each person's own commit name and address on this sandbox, keyed by sign-in address ("" is the one person of a
// sandbox nobody signs in to). On the history volume beside the other per-person records, so no address rides a tracked
// file. Carried: it is theirs, and asking again after a move would be a question already answered.
export const memberCommitIdentityDocument = defineDocument({
    root: "history",
    path: "member-commit-identity.json",
    portability: "carry",
    schema: z.object({ members: z.record(z.string(), z.object({ name: z.string(), email: z.string() })) }),
});

export interface MemberCommitIdentities {
    readonly get: (member: string) => Promise<GitPerson | undefined>;
    // Replaces this person's identity; undefined forgets it.
    readonly set: (member: string, person: GitPerson | undefined) => Promise<void>;
}

const fileMemberCommitIdentities = (path: string): MemberCommitIdentities => {
    // Absent or unreadable reads as nobody having set one; the next answer writes a fresh file.
    const file = openDocument(memberCommitIdentityDocument, path, { fallback: () => ({ members: {} }) });
    return {
        get: async (member) => (await file.read()).members[member],
        set: async (member, person) => {
            await file.update((state) => {
                const others = Object.fromEntries(Object.entries(state.members).filter(([key]) => key !== member));
                return { members: person === undefined ? others : { ...others, [member]: { name: person.name, email: person.email } } };
            });
        },
    };
};

// Every handle on one path shares its write queue (open-document.ts), so one is opened per use.
export const memberCommitIdentities = (services: Pick<Services, "config">): MemberCommitIdentities =>
    fileMemberCommitIdentities(join(services.config.historyRoot, memberCommitIdentityDocument.path));

// Whose identity a verified caller names: the person who signed in, the one person of a sandbox nobody signs in to, or
// nobody (a program holding a token, whose commits name no person).
export const memberOfCaller = (services: Pick<Services, "auth">, identity: { readonly email: string } | undefined): string | undefined => {
    if (identity !== undefined) {
        return identity.email.toLowerCase();
    }
    return services.auth === undefined ? "" : undefined;
};

// Whose identity a conversation's commits name: whoever answers for it now. One an automation or a program opened has
// no owner and names nobody, unless nobody signs in to this sandbox at all.
export const memberOfConversation = (services: Pick<Services, "auth" | "agents">, conversationId: string | undefined): string | undefined =>
    conversationId === undefined ? undefined : memberOfCaller(services, services.agents.entry(conversationId)?.social.owner);

type AttributionServices = Pick<Services, "config" | "sandboxSettings">;

// The person behind a commit, as the owner's policy lets it name them; nobody for no member, a member who set no
// identity, or a sandbox whose commits name nobody.
export const attributionFor = async (services: AttributionServices, member: string | undefined): Promise<Attribution> => {
    if (member === undefined) {
        return UNATTRIBUTED;
    }
    const { commitAttribution } = await services.sandboxSettings.get();
    if (commitAttribution === "intentic") {
        return UNATTRIBUTED;
    }
    return attributionOf(commitAttribution, await memberCommitIdentities(services).get(member));
};

// Who signs a commit a person's own press makes (a revert, a merge from the history graph): no trailer rides those.
export const callerSigner = async (
    services: AttributionServices & Pick<Services, "auth">,
    identity: { readonly email: string } | undefined,
): Promise<CommitSigner> => (await attributionFor(services, memberOfCaller(services, identity))).signer;

// An agent's own commits: the person it works for under `person`, the agent otherwise. A trailer cannot ride git's
// config, so under `trailer` its commits name the agent and the land that brings them to main names the person. Takes
// the policy the turn already read, so a turn under any other policy reads nothing more.
export const agentCommitEnv = async (
    services: Pick<Services, "config" | "auth" | "agents">,
    policy: CommitAttribution | undefined,
    conversationId: string | undefined,
): Promise<Record<string, string>> => {
    const member = policy === "person" ? memberOfConversation(services, conversationId) : undefined;
    const person = member === undefined ? undefined : await memberCommitIdentities(services).get(member);
    const signs = person ?? AGENT_GIT_AUTHOR;
    return { [AGENT_COMMIT_NAME]: signs.name, [AGENT_COMMIT_EMAIL]: signs.email };
};

// The caller's own commit identity, with `suggest` (the connected git account's, which the settings routes look up)
// offered to the sandbox's owner while they have none: that account is the owner's, so it is never offered to another
// member, and never asked for on their behalf.
export const commitIdentityState = async (
    services: AttributionServices & Pick<Services, "ownerEmail">,
    member: string,
    suggest: () => Promise<GitPerson | undefined>,
): Promise<CommitIdentityState> => {
    const [identity, { commitAttribution }] = await Promise.all([memberCommitIdentities(services).get(member), services.sandboxSettings.get()]);
    if (identity !== undefined) {
        return { identity, attribution: commitAttribution };
    }
    const owner = member === "" || member === (await services.ownerEmail())?.toLowerCase();
    // allow(silent-catch): a suggestion that cannot be looked up is no suggestion; the person types their own.
    const suggested = owner ? await suggest().catch(() => undefined) : undefined;
    return { ...opt("suggested", suggested), attribution: commitAttribution };
};

// A log row with the person its work was done for, read from the commit's last Conversation-Id trailer and the
// registry's owner of that conversation (archived ones included). Read from the sandbox, never from the commit, so
// history names them even under `intentic`, and only to those who can already read this sandbox's history.
const TRAILER = new RegExp(`^${CONVERSATION_TRAILER}: (\\S+)$`, "gm");
export const withRequester = (services: Pick<Services, "agents">, commit: GitCommit): GitCommit => {
    const conversation = [...commit.body.matchAll(TRAILER)].at(-1)?.[1];
    if (conversation === undefined) {
        return commit;
    }
    const owner = services.agents.entry(conversation)?.social.owner;
    return { ...commit, requestedBy: { conversation, ...opt("name", owner?.name), ...opt("email", owner?.email) } };
};
