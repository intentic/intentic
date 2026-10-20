import type { HarnessCredential } from "../agent/providers/agent-request.js";
import type { PrivacyShield } from "./privacy-shield.js";

// Puts a Claude Code harness credential behind the privacy shield's gateway: the harness then sends every model request,
// its own compaction, subagents and web-fetch summaries included, to the gateway, which forwards it where the credential
// would have sent it. A subscription token goes only to the gateway on this machine and from there only to Anthropic,
// pinned in the signed session, so the rule that it never reaches a foreign endpoint holds.

// Where a native Claude request goes with no base URL of the turn's own: the container's, else Anthropic's.
export const anthropicUpstream = (): string => {
    const configured = process.env["ANTHROPIC_BASE_URL"]?.trim();
    return configured === undefined || configured === "" ? "https://api.anthropic.com" : configured;
};

export const upstreamOf = (credential: HarnessCredential): string =>
    credential.kind === "routed" || credential.kind === "trial" ? credential.baseUrl : anthropicUpstream();

// The credential as the harness should spend it: unchanged while the shield is off. A policy that can't be read throws,
// which refuses the turn rather than running it unshielded.
export const shieldHarnessCredential = async (
    shield: Pick<PrivacyShield, "baseUrlFor">,
    credential: HarnessCredential,
    session: { readonly provider: string; readonly conversationId?: string | undefined },
): Promise<HarnessCredential> => {
    const gateway = await shield.baseUrlFor({ provider: session.provider, upstream: upstreamOf(credential), conversationId: session.conversationId });
    return gateway === undefined ? credential : { ...credential, gateway };
};

// OpenCode's one shared server fixes its providers' base URLs at spawn, so a shield turned on while it serves other
// conversations reaches it only once they finish: until then a turn on it would go past the gateway. Asked before every
// turn on it, which is also what restarts an idle server booted the old way.
export const sharedServerRefusal = async (
    shield: Pick<PrivacyShield, "refusal">,
    shielded: () => Promise<boolean>,
    provider: string,
    conversationId: string | undefined,
): Promise<string | undefined> => {
    // allow(silent-catch): a server whose standing can't be read is taken to be in front of no gateway, which refuses an
    // untrusted provider while the shield masks and nothing else.
    const behind = await shielded().catch(() => false);
    return shield.refusal({ provider, conversationId, route: behind ? "gateway" : "shared-server" });
};
