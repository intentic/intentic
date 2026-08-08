import type { Capability, Identity } from "@intentic/sandbox-contract";

/* WHICH OF THE SANDBOX'S CONNECTED ACCOUNTS ONE TURN MAY ACT THROUGH — the whole identity layer in one
 * function, so the rule lives in a single place instead of being re-derived at each surface that needs it.
 *
 * The rule is asymmetric on purpose, and the asymmetry is the design rather than an inconsistency:
 *
 *   A CHAT WITH NO IDENTITY KEEPS EVERY ACCOUNT. A person is sitting at the composer. They can see what the
 *   agent is about to do and stop it, and making them pick a face before a throwaway "check our mentions" would
 *   tax every ordinary turn to prevent a mistake a human is already positioned to catch.
 *
 *   AN UNATTENDED WAKE WITH NO IDENTITY GETS NOTHING. Nobody is watching, the prompt may have been shaped by a
 *   stranger (a Doorbell), and the failure mode is a public post from the wrong account that cannot be taken
 *   back. Here the prompt's wording is the only thing left standing, and the codebase already has this argument
 *   settled for tools: an automation's allowlist bounds what an injected instruction can reach precisely because
 *   advice does not. An identity is that same reasoning applied to whose name is on the result.
 *
 * NAMING AN IDENTITY THAT DOES NOT EXIST DENIES EVERYTHING, attended or not. It is the one case where falling
 * back to "all accounts" would be actively perverse: the owner asked for one specific face, and answering a
 * missing card with every account they own inverts the request into the exact accident the layer exists to
 * stop. A card can go missing for entirely ordinary reasons — a workspace cloned before its identities were
 * committed, a card renamed in one place and not the other — so this is a state to REPORT, not to assume away.
 *
 * NOTE ON WHAT THIS BOUNDS. It gates the logged-in browser accounts a turn is handed. It does not gate the
 * credential-free browser (that one holds no identity — reading a docs page is nobody's account), and it is not
 * a barrier against an agent that goes looking for a token with a shell. See IdentitySchema: this prevents the
 * wrong-account mistake, and is deliberately not sold as more than that. */

// Why a turn ended up with the account set it did — for the log line, and for the surfaces that explain a turn
// that could not reach the account its prompt clearly expected.
export type IdentityReason =
    // No identity named, and someone is watching: every connected account, exactly as before this layer existed.
    | "attended-open"
    // An identity was named and found: exactly the accounts on its card.
    | "identity"
    // Nobody watching and no identity named: no logged-in account at all.
    | "unattended-unpinned"
    // An identity was named and no card carries that id: no logged-in account at all.
    | "unknown-identity";

export interface TurnIdentity {
    // The card that was named and found, for the turn's voice and posture. Absent in every other case.
    readonly identity: Identity | undefined;
    // Whether this turn may act through a given capability id. The ONE question the turn path asks.
    readonly allows: (capabilityId: string) => boolean;
    readonly reason: IdentityReason;
}

export interface TurnIdentityInput {
    readonly identities: readonly Identity[];
    // AgentTurn.actsAs — the identity the turn asked to wear.
    readonly actsAs: string | undefined;
    // AgentTurn.unattended — whether anyone is at a composer. The hinge the whole rule turns on.
    readonly unattended: boolean;
}

const NONE = (): boolean => false;
const ALL = (): boolean => true;

export const turnIdentity = ({ identities, actsAs, unattended }: TurnIdentityInput): TurnIdentity => {
    if (actsAs === undefined) {
        return unattended
            ? { identity: undefined, allows: NONE, reason: "unattended-unpinned" }
            : { identity: undefined, allows: ALL, reason: "attended-open" };
    }
    const identity = identities.find((entry) => entry.id === actsAs);
    if (identity === undefined) {
        return { identity: undefined, allows: NONE, reason: "unknown-identity" };
    }
    const allowed = new Set(identity.capabilities);
    return { identity, allows: (capabilityId) => allowed.has(capabilityId), reason: "identity" };
};

/* The capability manifest as this turn may see it: every non-browser entry untouched, and the logged-in browser
 * accounts filtered to the ones the identity speaks for.
 *
 * Narrowed HERE, before the browser servers are built, rather than by trimming tool names afterwards. A browser
 * account that is filtered out has no MCP server spawned for it at all, so its Chromium never launches and its
 * profile is never opened — the account is absent from the turn rather than present-and-discouraged, which is
 * the only version of this that survives an agent misreading its instructions.
 *
 * Only `browser` entries are filtered. The other kinds are the sandbox's own machinery — an MCP server, a
 * database URL, a deploy credential — and they are not faces the outside world reads as a person. When the
 * credential connectors grow an identity of their own this is the one line that changes. */
export const identityCapabilities = (capabilities: readonly Capability[], identity: TurnIdentity): Capability[] =>
    capabilities.filter((capability) => capability.kind !== "browser" || identity.allows(capability.id));

/* What to append to the turn's guidance when a face is on. Two sentences at most: the model is already told, per
 * account, that its tools belong to exactly one account (see browser-skill.ts) — this says which of them the
 * owner meant for THIS turn, and whether it may publish without asking.
 *
 * Returns undefined when there is nothing worth saying: an open attended turn is the status quo and needs no
 * narration, and a turn with no accounts at all is better served by the tools simply not being there than by a
 * paragraph explaining their absence. */
export const identityNote = (identity: TurnIdentity): string | undefined => {
    const card = identity.identity;
    if (card === undefined) {
        return undefined;
    }
    const name = card.label ?? card.id;
    const posture =
        card.posture === "draft"
            ? ` This identity does NOT publish directly: prepare a draft for the owner to approve instead of posting, replying, or sending.`
            : ``;
    const voice = card.voice === undefined ? `` : `\n\n${card.voice}`;
    return `You are acting as ${name}. Only that identity's accounts are available to you this turn; if a task needs a different one, stop and say so rather than using whatever is at hand.${posture}${voice}`;
};
