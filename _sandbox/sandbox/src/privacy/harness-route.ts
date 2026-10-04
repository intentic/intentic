import type { HarnessCredential } from "../agent/providers/agent-request.js";
import { opt } from "../opt.js";
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

// The credential as the harness should spend it: unchanged while the shield is off, unless the conversation's old tool
// results are cleared, which only the gateway can do (gateway/tool-result-clearing.ts); then it goes through the gateway
// as a relay, marked so the harness keeps everything else as it was. A policy that can't be read throws, which refuses
// the turn rather than running it unshielded.
export const shieldHarnessCredential = async (
    shield: Pick<PrivacyShield, "baseUrlFor" | "relayUrlFor">,
    credential: HarnessCredential,
    session: { readonly provider: string; readonly conversationId?: string | undefined; readonly clearing?: boolean | undefined },
): Promise<HarnessCredential> => {
    const gatewaySession = {
        provider: session.provider,
        upstream: upstreamOf(credential),
        conversationId: session.conversationId,
        ...opt("clearing", session.clearing === true ? true : undefined),
    };
    const gateway = await shield.baseUrlFor(gatewaySession);
    if (gateway !== undefined) {
        return { ...credential, gateway };
    }
    return session.clearing === true ? { ...credential, gateway: await shield.relayUrlFor(gatewaySession), clearingOnly: true } : credential;
};

// OpenCode's one shared server fixes its providers' base URLs at spawn, so a shield turned on while it serves other
// conversations reaches it only once they finish. Asked before every Grok or Gemini turn, which is also what restarts
// an idle server booted the old way; a refusal sentence only while it would run an untrusted provider unshielded.
export const sharedServerRefusal = async (
    shield: Pick<PrivacyShield, "policy" | "trusted">,
    shielded: () => Promise<boolean>,
    provider: string,
): Promise<string | undefined> => {
    if (await shielded()) {
        return undefined;
    }
    const policy = await shield.policy();
    if (policy.mode !== "on" || (await shield.trusted(policy, provider))) {
        return undefined;
    }
    return "The privacy shield was turned on while other Grok or Gemini conversations were running on the shared OpenCode server, which was started before it. Send again once they finish, and this one runs behind the shield.";
};
