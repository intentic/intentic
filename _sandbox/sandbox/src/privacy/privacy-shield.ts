import type {
    AgentHarness,
    Capability,
    PrivacyKnownSource,
    PrivacyKnownValue,
    PrivacyShieldPolicy,
    PrivacyShieldStatus,
} from "@intentic/sandbox-contract";
import { detectPersonalData, normalizeAllowed } from "./detect/detect.js";
import { createMasker, createMaskMemo, type EntityRecognizer, type Masker } from "./masker.js";
import type { PrivacyLedger } from "./privacy-ledger.js";
import type { PrivacyPolicyStore } from "./privacy-policy.js";
import { isTrustedProvider, privacyProviders, shieldableRuntime } from "./privacy-trust.js";
import type { PrivacyVault } from "./privacy-vault.js";
import type { LocalReaders } from "./readers.js";
import type { GatewaySession, SessionTokens } from "./gateway/session-token.js";
import { createReadingMemo, type ReadingMemo } from "./gateway/request-shield.js";
import { TOKEN_LABEL } from "./tokens.js";

// The privacy shield as the rest of the daemon sees it: the owner's policy, the decision whether a turn may run, the
// base URL a runtime is pointed at, and the masker every other exit (push, shares) borrows. The gateway route that does
// the masking on the wire reads its parts from here.

// Why a turn was refused, or nothing: it may run.
export type ShieldAdmission = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface PrivacyShield {
    readonly policy: () => Promise<PrivacyShieldPolicy>;
    readonly setPolicy: (policy: PrivacyShieldPolicy) => Promise<void>;
    readonly status: () => Promise<PrivacyShieldStatus>;
    // Whether a turn on this provider and harness may run under the policy in force; in a conversation, a grant the owner
    // made for that one counts.
    readonly admit: (provider: string, harness: AgentHarness, conversationId?: string) => Promise<ShieldAdmission>;
    // The base URL a runtime should send its model requests to instead of `upstream`; undefined while the shield is off,
    // so a sandbox that never turned it on sends nothing through the daemon.
    readonly baseUrlFor: (session: GatewaySession) => Promise<string | undefined>;
    // The same gateway whatever the policy, for a session that needs it for something other than the shield: a
    // conversation whose old tool results are cleared (gateway/tool-result-clearing.ts). Off, the gateway masks nothing
    // and logs nothing, so this is a relay that only clears.
    readonly relayUrlFor: (session: GatewaySession) => Promise<string>;
    // Whether a provider may read personal data as it is under a policy, everywhere or in this conversation: the gateway
    // is a plain relay for it, and a runtime the gateway cannot cover may run.
    readonly trusted: (policy: PrivacyShieldPolicy, provider: string, conversationId?: string) => Promise<boolean>;
    // A masker for the policy in force; cheap, since its memo and vault are shared.
    readonly masker: (policy: PrivacyShieldPolicy) => Promise<Masker>;
    // Text for a place that must not hold personal data and never comes back (a push notification): every finding
    // becomes its kind's label, with no token to resolve. Unchanged while the shield is off.
    readonly redactForDisplay: (text: string) => Promise<string>;
    readonly learn: (source: string, values: readonly PrivacyKnownValue[]) => Promise<{ added: number; known: number }>;
    readonly forget: (source: string) => Promise<number>;
    readonly sources: () => Promise<PrivacyKnownSource[]>;
    readonly vault: PrivacyVault;
    readonly ledger: PrivacyLedger;
    readonly readers: LocalReaders;
    readonly readings: ReadingMemo;
    readonly tokens: SessionTokens;
}

export interface PrivacyShieldDeps {
    readonly policyStore: PrivacyPolicyStore;
    readonly vault: PrivacyVault;
    readonly ledger: PrivacyLedger;
    readonly readers: LocalReaders;
    readonly tokens: SessionTokens;
    readonly capabilities: () => Promise<readonly Capability[]>;
    // The daemon's loopback base, where a runtime reaches the gateway route.
    readonly loopbackBase: () => string;
    // The local name model, when installed and asked for; undefined otherwise.
    readonly recognizer: () => Promise<EntityRecognizer | undefined>;
    // Whether that model is installed, for the status.
    readonly recognizerInstalled: () => Promise<boolean>;
}

export const GATEWAY_PATH = "/privacy/gateway";

// Why a provider the shield cannot cover was turned away. Decided by the runtime alone, before a word of the turn is
// read, so the sentence says that first: read as a finding (2026-10-02), it sent the owner looking for personal data in
// a message that held none, when what the shield cannot see is everything such a turn goes on to read.
export const unshieldedRefusal = (label: string, inConversation: boolean): string =>
    [
        `The privacy shield turned ${label} away before reading anything: nothing in what you sent was flagged.`,
        `${label}'s agent sends what it reads (files, command output, session records) to its own servers on a wire the shield can't read, so it can't mask personal data on the way, and an untrusted ${label} does not run while the shield is on.`,
        inConversation
            ? `Let ${label} read this conversation as it is from the strip above the composer, trust it everywhere in Sandbox ▸ Agent ▸ Safety, or pick a provider the shield covers.`
            : `Trust it in Sandbox ▸ Agent ▸ Safety, or pick a provider the shield covers.`,
    ].join(" ");

export const createPrivacyShield = (deps: PrivacyShieldDeps): PrivacyShield => {
    const memo = createMaskMemo();
    const readings = createReadingMemo();
    const trusted = async (policy: PrivacyShieldPolicy, provider: string, conversationId?: string): Promise<boolean> =>
        isTrustedProvider(policy, provider, await deps.capabilities(), conversationId);
    const masker = async (policy: PrivacyShieldPolicy): Promise<Masker> =>
        createMasker({
            vault: deps.vault,
            policy,
            memo,
            recognizer: policy.names === "model" ? await deps.recognizer() : undefined,
        });
    return {
        policy: deps.policyStore.get,
        setPolicy: deps.policyStore.set,
        status: async () => {
            const [policy, counts, ocr, model, capabilities] = await Promise.all([
                deps.policyStore.get(),
                deps.vault.counts(),
                deps.readers.ocr(),
                deps.recognizerInstalled(),
                deps.capabilities(),
            ]);
            return { policy, known: counts.known, tokens: counts.tokens, readers: { ocr, model }, providers: privacyProviders(capabilities) };
        },
        admit: async (provider, harness, conversationId) => {
            const policy = await deps.policyStore.get();
            if (policy.mode !== "on" || shieldableRuntime(provider, harness) || (await trusted(policy, provider, conversationId))) {
                return { allowed: true };
            }
            const label = privacyProviders(await deps.capabilities()).find((entry) => entry.id === provider)?.label ?? provider;
            return { allowed: false, reason: unshieldedRefusal(label, conversationId !== undefined) };
        },
        baseUrlFor: async (session) => {
            const policy = await deps.policyStore.get();
            if (policy.mode === "off") {
                return undefined;
            }
            return `${deps.loopbackBase()}${GATEWAY_PATH}/${await deps.tokens.sign(session)}`;
        },
        relayUrlFor: async (session) => `${deps.loopbackBase()}${GATEWAY_PATH}/${await deps.tokens.sign(session)}`,
        trusted,
        masker,
        redactForDisplay: async (text) => {
            const policy = await deps.policyStore.get();
            if (policy.mode !== "on") {
                return text;
            }
            const spans = detectPersonalData(text, { classes: new Set(policy.classes), allow: new Set(policy.allow.map(normalizeAllowed)) });
            await deps.vault.load();
            const known = deps.vault.matcher().find(text);
            const all = [
                ...known.map((hit) => ({ start: hit.start, end: hit.end, label: TOKEN_LABEL[hit.payload.class] })),
                ...spans.map((span) => ({ start: span.start, end: span.end, label: TOKEN_LABEL[span.class] })),
            ].toSorted((left, right) => left.start - right.start || right.end - left.end);
            let out = "";
            let last = 0;
            for (const span of all) {
                if (span.start < last) {
                    continue;
                }
                out += `${text.slice(last, span.start)}‹${span.label.toLowerCase().replaceAll("_", " ")}›`;
                last = span.end;
            }
            return out + text.slice(last);
        },
        learn: deps.vault.learn,
        forget: deps.vault.forget,
        sources: deps.vault.sources,
        vault: deps.vault,
        ledger: deps.ledger,
        readers: deps.readers,
        readings,
        tokens: deps.tokens,
    };
};

// Keys whose strings are structure, not words: ids, kinds and paths a page or a client resolves by.
const STRUCTURAL_KEYS = new Set(["id", "type", "kind", "path", "published", "source", "url", "name", "tool", "status", "role", "mediaType"]);

// Every string a value holds, through `redact`, except the structural ones; for a page leaving this machine whole (a
// public share), where nothing comes back to restore.
export const redactStrings = async (value: unknown, redact: (text: string) => Promise<string>, key?: string): Promise<unknown> => {
    if (typeof value === "string") {
        return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : redact(value);
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => redactStrings(item, redact)));
    }
    if (value !== null && typeof value === "object") {
        const entries = await Promise.all(
            Object.entries(value).map(async ([field, item]) => [field, await redactStrings(item, redact, field)] as const),
        );
        return Object.fromEntries(entries);
    }
    return value;
};
