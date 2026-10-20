import { type PrivacyShieldPolicy, trustedInConversation } from "./privacy.js";

// THE ONE DECISION about bytes bound for a model provider: pass them as they are, watch them, mask them, or refuse them.
// Every place they leave by asks it (the gateway, a hooked runtime's channels, a sealed helper prompt, a turn's
// admission, a runner's placement, a credential that would go around the gateway), and so does the editor before a
// send, so the warning above the composer is this verdict and never a guess of its own. Before 2026-10-20 the formula
// was written out at each of those places, and they drifted: helpers refused where turns ran, a child kept here where
// its parent could go, a strip that warned on opening a composer and stayed silent about a runner.

// How bytes reach the provider. Through a seam the shield reads every byte at: the gateway a runtime is pointed at, the
// hooks a runtime hands each channel's text to before its model reads it, a sealed prompt (a helper's whole request, in
// hand before any runtime has it). Or past every seam: a runtime with neither (an ACP agent, Pi), a runner calling its
// provider from its own machine, a key the provider is called with directly (Codex on the container's OpenAI key), a
// shared server started before the shield was on.
export type PrivacySeam = "gateway" | "hooks" | "sealed";
export type PrivacyBypass = "runtime" | "runner" | "own-key" | "shared-server";
export type PrivacyRoute = PrivacySeam | PrivacyBypass;

const SEAMS: ReadonlySet<PrivacyRoute> = new Set<PrivacySeam>(["gateway", "hooks", "sealed"]);
const isSeam = (route: PrivacyRoute): route is PrivacySeam => SEAMS.has(route);

// The route of a turn on a runtime, from its `privacy` capability (agent-runtimes.ts), placed on `runner` or here.
export const turnRoute = (privacy: "gateway" | "hooks" | "none", runner?: string): PrivacyRoute =>
    runner !== undefined ? "runner" : privacy === "none" ? "runtime" : privacy;

export interface PrivacyEgress {
    readonly provider: string;
    // A model this machine serves: nothing it reads leaves.
    readonly local: boolean;
    // A conversation's own grant counts there; a request outside any conversation has none.
    readonly conversationId?: string | undefined;
    readonly route: PrivacyRoute;
}

// Why bytes pass as they are: the shield is off, the model is on this machine, the owner trusts the provider everywhere
// or let it read this conversation, or the shield only watches and cannot see this route at all.
export type PassReason = "off" | "local" | "trusted" | "granted" | "unwatched";

export type ShieldVerdict =
    | { readonly kind: "pass"; readonly because: PassReason }
    | { readonly kind: "watch" }
    | { readonly kind: "mask" }
    | { readonly kind: "refuse"; readonly route: PrivacyBypass };

const pass = (because: PassReason): ShieldVerdict => ({ kind: "pass", because });

export const shieldVerdict = (policy: Pick<PrivacyShieldPolicy, "mode" | "trusted" | "conversations">, egress: PrivacyEgress): ShieldVerdict => {
    if (policy.mode === "off") {
        return pass("off");
    }
    if (egress.local) {
        return pass("local");
    }
    if (policy.trusted.includes(egress.provider)) {
        return pass("trusted");
    }
    if (trustedInConversation(policy, egress.provider, egress.conversationId)) {
        return pass("granted");
    }
    if (!isSeam(egress.route)) {
        return policy.mode === "on" ? { kind: "refuse", route: egress.route } : pass("unwatched");
    }
    return policy.mode === "on" ? { kind: "mask" } : { kind: "watch" };
};

// Whether the owner let the provider read what it is sent as it is (here, everywhere, or in this conversation): what
// the log calls trusted.
export const ownerTrusted = (verdict: ShieldVerdict): boolean =>
    verdict.kind === "pass" && (verdict.because === "local" || verdict.because === "trusted" || verdict.because === "granted");

// The failure codes a turn the shield turned away ends with: refused by its verdict (`privacy-unshielded`), or for what
// it found where it could not mask (`privacy-instructions`). The way through both is the same grant.
const REFUSAL_CODES: ReadonlySet<string> = new Set(["privacy-unshielded", "privacy-instructions"]);
export const isPrivacyRefusal = (code: string | undefined): boolean => code !== undefined && REFUSAL_CODES.has(code);
