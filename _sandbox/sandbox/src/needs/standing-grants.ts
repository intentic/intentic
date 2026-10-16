import { oneLine } from "@intentic/base/one-line";
import {
    type ConversationGrantRevoke,
    type GrantRevoke,
    OWNER_GRANT_KINDS,
    type OwnerGrant,
    type OwnerGrantKind,
    type OwnerGrantRevoke,
    type StandingGrants,
} from "@intentic/sandbox-contract/schemas/needs";
import type { SettingsHook } from "@intentic/sandbox-contract/schemas/approvals";
import { opt } from "../opt.js";
import { approvedExtensions } from "../capabilities/extension-inventory/extension-approvals.js";
import { approvedHookSets, revokeHookSet } from "../guard/hook-approvals.js";
import type { ConversationGrants } from "../personas/conversation-grants.js";
import type { OwnerGrants } from "../personas/owner-grants.js";
import type { CredentialGrants } from "../secrets/credential-grants.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

// The yeses still standing (docs/architecture/needs.md): what a grant need's "Allow for this conversation" widened, and
// which gated credentials a release need let through, and whether its installs run unasked, by conversation, where a
// person reviews and takes them back. A grant is read as a turn is planned and a release mounts at the next turn; the
// install grant is read at each install, so taking it back asks again from the next one. A credential gateway rule's pass
// is read as each request arrives, so taking it back asks again at the next one.
//
// Beside them, the yeses that name no conversation (`ownerWide`), each kept off the workspace where no agent writes: a
// command policy line allowed with Always (personas/owner-grants.ts), a Claude Code hook set the owner approved by its
// digest (guard/hook-approvals.ts) and a workspace extension they approved for the powers it declared
// (capabilities/extension-inventory/extension-approvals.ts). One list reads all three and one door takes any of them back. A policy line goes
// from the next turn's judge; a hook set is unapproved from the next turn, which asks again; an extension goes back to
// waiting for a yes, with its processes stopped, its files and settings left where they are.

// The owner's yes to hook sets and workspace extensions, pinned by digest under the history volume where no workspace
// write reaches, and how each is taken back. A seam of its own so a suite stands the list up without a volume.
export interface OwnerApprovals {
    readonly hookSets: () => Promise<Awaited<ReturnType<typeof approvedHookSets>>>;
    // Whether there was a set approved by that digest to take back.
    readonly revokeHookSet: (digest: string) => Promise<boolean>;
    readonly extensions: () => Promise<Awaited<ReturnType<typeof approvedExtensions>>>;
    // Takes an approved workspace extension back to waiting for its yes (extensions/extension-removal.ts), converging what
    // runs from it; whether there was an approval to take back.
    readonly revokeExtension: (id: string) => Promise<boolean>;
}

export const ownerApprovals = (historyRoot: string, revokeExtension: OwnerApprovals["revokeExtension"]): OwnerApprovals => ({
    hookSets: () => approvedHookSets(historyRoot),
    revokeHookSet: (digest) => revokeHookSet(historyRoot, digest),
    extensions: () => approvedExtensions(historyRoot),
    revokeExtension,
});

export interface StandingGrantsDeps {
    readonly conversationGrants: ConversationGrants;
    readonly credentialGrants: CredentialGrants;
    readonly ownerGrants: OwnerGrants;
    readonly approvals: OwnerApprovals;
}

type StandingConversation = StandingGrants["conversations"][number];

const lastChange = (conversation: StandingConversation): number =>
    Math.max(conversation.updatedAt ?? 0, ...conversation.releases.map((release) => release.at));

// A hook in the daemon's words for a row that holds many: when it runs, which tools it is limited to, and what it runs.
const hookSaid = (hook: SettingsHook): string =>
    oneLine(`${hook.event}${hook.matcher === undefined ? `` : ` (${hook.matcher})`}: ${hook.run}`, 160);

// Every yes that names no conversation, newest first, and which of the three records this build could not read (none of
// that kind stands until it is fixed).
const ownerWideOf = async ({ ownerGrants, approvals }: StandingGrantsDeps): Promise<Pick<StandingGrants, "ownerWide" | "unreadable">> => {
    const [policy, hookSets, extensions] = await Promise.all([ownerGrants.read(), approvals.hookSets(), approvals.extensions()]);
    const grants: OwnerGrant[] = [
        ...policy.commandPolicy.map((grant): OwnerGrant => ({ kind: `command-policy`, line: grant.line, at: grant.at, ...opt("by", grant.by) })),
        ...hookSets.sets.map((set): OwnerGrant => ({ kind: `hook-set`, digest: set.digest, hooks: set.hooks.map(hookSaid), at: set.approvedAt })),
        ...extensions.extensions.map((extension): OwnerGrant => ({ kind: `extension`, id: extension.id, powers: [...extension.powers], at: extension.approvedAt })),
    ];
    const unreadable: OwnerGrantKind[] = [
        ...(policy.unreadable ? [`command-policy` as const] : []),
        ...(hookSets.unreadable ? [`hook-set` as const] : []),
        ...(extensions.unreadable ? [`extension` as const] : []),
    ];
    return { ownerWide: grants.toSorted((left, right) => right.at - left.at), unreadable };
};

export const standingGrants = async (deps: StandingGrantsDeps): Promise<StandingGrants> => {
    const { conversationGrants, credentialGrants } = deps;
    const grants = await conversationGrants.all();
    const releases = credentialGrants.all();
    const ids = new Set([...Object.keys(grants), ...releases.map((release) => release.conversationId)]);
    const conversations = [...ids].map((conversationId): StandingConversation => {
        const grant = grants[conversationId];
        return {
            conversationId,
            capabilities: [...(grant?.capabilities ?? [])],
            folders: [...(grant?.folders ?? [])],
            shelves: [...(grant?.shelves ?? [])],
            installs: grant?.installs === true,
            secrets: [...(grant?.secrets ?? [])],
            everything: grant?.everything === true,
            rules: (grant?.rules ?? []).map((pass) => ({ ...pass })),
            ...opt("by", grant?.by),
            ...opt("updatedAt", grant?.updatedAt),
            releases: releases
                .filter((release) => release.conversationId === conversationId)
                .map(({ subject, grant: released }) => ({ subject, approvedBy: released.approvedBy, at: released.at })),
        };
    });
    // The most recently widened first: the one a person just allowed is the one they came to check.
    return { conversations: conversations.sort((left, right) => lastChange(right) - lastChange(left)), ...(await ownerWideOf(deps)) };
};

const OWNER_KINDS: ReadonlySet<string> = new Set(OWNER_GRANT_KINDS);

// A conversation's yes carries its conversation; an owner-wide one names none, so its kind is how the two tell apart.
export const isOwnerRevoke = (input: GrantRevoke): input is OwnerGrantRevoke => OWNER_KINDS.has(input.kind);

const revokeOwnerWide = async ({ ownerGrants, approvals }: StandingGrantsDeps, input: OwnerGrantRevoke): Promise<boolean> => {
    if (input.kind === `command-policy`) {
        return ownerGrants.revokeCommandPolicy(input.what);
    }
    if (input.kind === `hook-set`) {
        return approvals.revokeHookSet(input.what);
    }
    return approvals.revokeExtension(input.what);
};

const revokeConversationGrant = async ({ conversationGrants, credentialGrants }: StandingGrantsDeps, input: ConversationGrantRevoke): Promise<boolean> => {
    if (input.kind === "release") {
        return credentialGrants.revoke(input.conversationId, input.what);
    }
    if (input.kind === "install") {
        return conversationGrants.revokeInstalls(input.conversationId);
    }
    if (input.kind === "everything") {
        return conversationGrants.revokeEverything(input.conversationId);
    }
    if (input.kind === "rule") {
        // A rule's identity is its content, which two capabilities may share: without the capability there is no telling
        // whose pass to take back, so nothing is.
        return input.capability === undefined ? false : conversationGrants.revokeRule(input.conversationId, input.capability, input.what);
    }
    return conversationGrants.revoke(input.conversationId, { subject: input.kind, what: input.what });
};

// Whether there was one to take back.
export const revokeGrant = (deps: StandingGrantsDeps, input: GrantRevoke): Promise<boolean> =>
    isOwnerRevoke(input) ? revokeOwnerWide(deps, input) : revokeConversationGrant(deps, input);

// Tells the editor's Allowed list to read again: a yes written by a card mid-turn, or a purge, moves no need, and the auth
// root it is kept under is watched by no file push. One frame for the whole list, so which conversation moved is not asked.
export const grantsChanged = (): void => {
    publishRuntimeChange("grants");
};
