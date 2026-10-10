import {
    type AgentHarness,
    type Capability,
    type PersonalDataClass,
    PRIVACY_REPLACEMENTS_MAX,
    type PrivacyKnownSource,
    type PrivacyKnownValue,
    type PrivacyLedgerAction,
    type PrivacyShieldPolicy,
    type PrivacyShieldStatus,
} from "@intentic/sandbox-contract";
import { detectPersonalData, normalizeAllowed } from "./detect/detect.js";
import { type ClassCounts, createMasker, createMaskMemo, type EntityRecognizer, type Masker, type Replacement } from "./masker.js";
import type { PrivacyLedger } from "./privacy-ledger.js";
import type { PrivacyPolicyStore } from "./privacy-policy.js";
import { gatewayRuntime, isTrustedProvider, privacyProviders, shieldableRuntime } from "./privacy-trust.js";
import type { PrivacyVault } from "./privacy-vault.js";
import type { LocalReaders } from "./readers.js";
import type { GatewaySession, SessionTokens } from "./gateway/session-token.js";
import { createReadingMemo, type ReadingMemo } from "./gateway/request-shield.js";
import { paintRegions, readingText, regionsFor } from "./image-mask.js";
import { TOKEN_LABEL, TOKEN_SOURCE } from "./tokens.js";
import { opt } from "../opt.js";

// The privacy shield as the rest of the daemon sees it: the owner's policy, the decision whether a turn may run, the
// base URL a runtime is pointed at, and the masker every other exit (push, shares) borrows. The gateway route that does
// the masking on the wire reads its parts from here.

// Why a turn was refused, or nothing: it may run.
export type ShieldAdmission = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

// A sealed request (agent/providers/agent-request.ts `policy.sealed`): its prompt is everything the model reads, since
// it carries no tools, reads no file and continues no session. Who it goes to, for the trust it is read against.
export interface SealedRequest {
    readonly provider: string;
    readonly harness: AgentHarness;
    readonly conversationId?: string | undefined;
    readonly prompt: string;
}

// A sealed request as the shield hands it on: the words to send, and how to read the answer back.
export interface SealedPrompt {
    readonly prompt: string;
    readonly restore: (text: string) => string;
}

// One turn on a runtime the gateway does not stand in front of but whose every channel passes the daemon first (privacy
// `hooks`, agent-runtimes.ts): each channel hands its text here before the model can read it. The policy is read on
// every call, as the gateway reads it on every request, so a grant made mid-turn opens the rest of it.
export interface TurnShield {
    readonly provider: string;
    readonly conversationId: string | undefined;
    // Text the model is about to read, as it may read it: masked while the shield masks (tokens `restore` reads back),
    // as it is while it watches (what it would have masked is logged), as it is while the provider is trusted. `channel`
    // names where it came from for the log. Throws when masking fails, and the caller withholds the text.
    readonly mask: (text: string, channel: string) => Promise<string>;
    // For a read the runtime can only allow or refuse (a file its model opens with its own tool): the kinds of personal
    // data that refuse it, empty when it may go as it is (nothing found, the shield only watching, the provider trusted).
    // `refusal` is the log's line for it when it is refused.
    readonly refuses: (text: string, channel: string, refusal: string) => Promise<readonly PersonalDataClass[]>;
    // The same for a picture, read on this machine; `unreadable` when it could not be read to be checked, which refuses
    // it as surely, since it would otherwise go unchecked.
    readonly refusesImage: (data: Buffer, channel: string) => Promise<readonly PersonalDataClass[] | "unreadable">;
    // The same for a PDF, read on this machine (its text layer, or its pages through OCR); `unreadable` when neither
    // yields text, which refuses it as surely.
    readonly refusesDocument: (data: Buffer, channel: string) => Promise<readonly PersonalDataClass[] | "unreadable">;
    // Tokens in what the model wrote back to the values they stand for.
    readonly restore: (text: string) => string;
    // Whether masking is in force right now: the shield on and the provider untrusted here. False while it watches.
    readonly masking: () => Promise<boolean>;
    // Where the runtime should call an MCP server instead of `url`: the masking proxy, which restores tokens in what the
    // model sends and masks what the server answers (gateway/mcp-route.ts).
    readonly mcpUrl: (url: string) => Promise<string>;
}

export interface PrivacyShield {
    readonly policy: () => Promise<PrivacyShieldPolicy>;
    readonly setPolicy: (policy: PrivacyShieldPolicy) => Promise<void>;
    readonly status: () => Promise<PrivacyShieldStatus>;
    // Whether an open request (a turn, whose runtime goes on to read what the shield never sees) on this provider and
    // harness may run under the policy in force; in a conversation, a grant the owner made for that one counts.
    readonly admit: (provider: string, harness: AgentHarness, conversationId?: string) => Promise<ShieldAdmission>;
    // A sealed request, read for what it holds rather than refused for its runtime: sent as it is when the gateway
    // already stands in front of that runtime, the provider is trusted, or nothing is found; masked here, with the
    // restore that reads tokens in the answer back, when something is. Never refuses: the whole request is in hand.
    // Throws when the policy can't be read or masking fails, which refuses the request rather than sending it as it is.
    readonly seal: (request: SealedRequest) => Promise<SealedPrompt>;
    // The shield for one turn on a hooked runtime (TurnShield), read by the same reader `seal` reads with; undefined when
    // there is nothing to read for: the shield is off, the provider is trusted here, or the gateway already covers it.
    readonly forTurn: (provider: string, harness: AgentHarness, conversationId?: string) => Promise<TurnShield | undefined>;
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
    // A picture for the same places: read on this machine and every finding painted over with its kind's label, and
    // re-encoded, so no metadata and no other frame goes with it. Undefined when it cannot be read (no reader, bytes
    // that do not decode), which means it must not go at all. The bytes as they are while the shield is off.
    readonly redactPictureForDisplay: (data: Buffer) => Promise<Buffer | undefined>;
    readonly learn: (source: string, values: readonly PrivacyKnownValue[]) => Promise<{ added: number; known: number }>;
    readonly forget: (source: string) => Promise<number>;
    readonly sources: () => Promise<PrivacyKnownSource[]>;
    // The value behind each token the vault gave out, for the owner checking what was masked; others are left out.
    readonly reveal: (tokens: readonly string[]) => Promise<Record<string, string>>;
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
export const MCP_PROXY_PATH = "/privacy/mcp";

// Why a provider on a runtime the shield cannot read at all (an ACP agent, Pi: no gateway, no hooks) was turned away.
// Decided by the runtime alone, before a word of the turn is read, so the sentence says that first: read as a finding
// (2026-10-02), it sent the owner looking for personal data in a message that held none, when what the shield cannot
// see is everything such a turn goes on to read.
export const unshieldedRefusal = (label: string, inConversation: boolean): string =>
    [
        `The privacy shield turned ${label} away before reading anything: nothing in what you sent was flagged.`,
        `${label}'s agent reads files and command output on its own and sends them to its provider on a wire the shield can't read, so it can't mask personal data on the way, and an untrusted ${label} does not run while the shield is on.`,
        inConversation
            ? `Let ${label} read this conversation as it is from the strip above the composer, trust it everywhere in Sandbox ▸ Agent ▸ Safety, or pick a provider the shield covers.`
            : `Trust it in Sandbox ▸ Agent ▸ Safety, or pick a provider the shield covers.`,
    ].join(" ");

// What one read through the shared reader came to: the text as the provider may read it, how to read tokens in its
// answer back, and what was found (empty when nothing was, or nothing was read for).
interface Reading {
    readonly text: string;
    readonly restore: (text: string) => string;
    readonly found: readonly Replacement[];
    readonly counts: ClassCounts;
}

// The kinds a reading holds, each once, in the order they sit in the text. Read off the spans rather than the counts:
// a text the memo has seen counts nothing again (masker.ts), and a file opened twice must be refused twice.
const kindsOf = (spans: readonly { readonly class: PersonalDataClass }[]): PersonalDataClass[] => [...new Set(spans.map((span) => span.class))];

// The counts a refusal is logged with: what this reading holds, whether or not the memo had seen it.
const countsOf = (spans: readonly { readonly class: PersonalDataClass }[]): ClassCounts => {
    const counts: Partial<Record<PersonalDataClass, number>> = {};
    for (const span of spans) {
        counts[span.class] = (counts[span.class] ?? 0) + 1;
    }
    return counts;
};

// Restoring reads the vault alone and never the policy (masker.ts `restore`); a masker needs one to be built.
const RESTORE_POLICY: Pick<PrivacyShieldPolicy, "classes" | "allow" | "names"> = { classes: [], allow: [], names: "dictionary" };

// One whole token, in either spelling.
const WHOLE_TOKEN = new RegExp(`^(?:${TOKEN_SOURCE})$`, "u");

// What a sealed request is logged as speaking: no wire format, since it was read here before any runtime had it.
export const SEALED_PROTOCOL = "sealed";

const unchanged = (text: string): string => text;

export const createPrivacyShield = (deps: PrivacyShieldDeps): PrivacyShield => {
    const memo = createMaskMemo();
    const readings = createReadingMemo();
    const trusted = async (policy: PrivacyShieldPolicy, provider: string, conversationId?: string): Promise<boolean> =>
        isTrustedProvider(policy, provider, await deps.capabilities(), conversationId);
    // What a place that keeps no token shows in place of each finding: its kind, the longest of overlapping ones winning.
    const displaySpans = async (text: string, policy: PrivacyShieldPolicy): Promise<{ start: number; end: number; label: string }[]> => {
        const spans = detectPersonalData(text, { classes: new Set(policy.classes), allow: new Set(policy.allow.map(normalizeAllowed)) });
        await deps.vault.load();
        const known = deps.vault.matcher().find(text);
        const all = [
            ...known.map((hit) => ({ start: hit.start, end: hit.end, label: TOKEN_LABEL[hit.payload.class] })),
            ...spans.map((span) => ({ start: span.start, end: span.end, label: TOKEN_LABEL[span.class] })),
        ].toSorted((left, right) => left.start - right.start || right.end - left.end);
        let last = 0;
        return all.filter((span) => {
            if (span.start < last) {
                return false;
            }
            last = span.end;
            return true;
        });
    };
    const masker = async (policy: PrivacyShieldPolicy): Promise<Masker> =>
        createMasker({
            vault: deps.vault,
            policy,
            memo,
            recognizer: policy.names === "model" ? await deps.recognizer() : undefined,
        });
    const record = (fields: {
        readonly provider: string;
        readonly conversationId: string | undefined;
        readonly action: PrivacyLedgerAction;
        readonly protocol: string;
        readonly counts: ClassCounts;
        readonly found: readonly Replacement[];
        readonly images?: number;
        readonly documents?: number;
        readonly detail?: string;
    }): void => {
        void deps.ledger
            .record({
                at: new Date().toISOString(),
                ...opt("conversationId", fields.conversationId),
                provider: fields.provider,
                trusted: false,
                action: fields.action,
                counts: fields.counts,
                images: fields.images ?? 0,
                documents: fields.documents ?? 0,
                protocol: fields.protocol,
                ...opt("detail", fields.detail),
                ...opt("replacements", fields.found.length > 0 ? fields.found.slice(0, PRIVACY_REPLACEMENTS_MAX) : undefined),
            })
            // allow(silent-catch): the log is the owner's record of what left, and a write it lost costs the request nothing
            .catch(() => undefined);
    };
    // Where the policy stands for one provider in one conversation, read fresh: whether to mask, or only to watch.
    const standing = async (provider: string, conversationId: string | undefined) => {
        const policy = await deps.policyStore.get();
        const open = policy.mode === "off" || (await trusted(policy, provider, conversationId));
        return { policy, masking: !open && policy.mode === "on", watching: !open && policy.mode === "watch" };
    };
    // THE READER every text bound for a provider the gateway does not stand in front of goes through: a sealed request's
    // prompt, and each channel of a hooked runtime's turn. Masked while the shield masks, read and logged while it
    // watches, untouched while it is off or the provider is trusted. `log` says when a reading earns a line: a sealed
    // request is a request and always does; a channel of a turn speaks often and logs only what it found.
    const read = async (input: {
        readonly provider: string;
        readonly conversationId: string | undefined;
        readonly text: string;
        readonly protocol: string;
        readonly log: "always" | "found";
    }): Promise<Reading> => {
        const nothing: Reading = { text: input.text, restore: unchanged, found: [], counts: {} };
        const { policy, masking, watching } = await standing(input.provider, input.conversationId);
        if ((!masking && !watching) || input.text === "") {
            return nothing;
        }
        const reading = await masker(policy);
        const found = masking ? await reading.mask(input.text) : await reading.find(input.text);
        // The tokens the provider is about to read must be on disk before it reads them, as on the wire.
        await deps.vault.commit();
        if (input.log === "always" || found.found.length > 0) {
            record({ ...input, action: masking ? "masked" : "watched", counts: found.counts, found: found.found });
        }
        // Watching sends the text as it came, so nothing in the answer is a token this reading gave out.
        return masking && "text" in found
            ? { text: found.text, restore: reading.restore, found: found.found, counts: found.counts }
            : { ...nothing, found: found.found, counts: found.counts };
    };
    const turnShield = (provider: string, conversationId: string | undefined): TurnShield => ({
        provider,
        conversationId,
        mask: async (text, channel) => (await read({ provider, conversationId, text, protocol: `hooks:${channel}`, log: "found" })).text,
        refuses: async (text, channel, refusal) => {
            const { policy, masking, watching } = await standing(provider, conversationId);
            if ((!masking && !watching) || text === "") {
                return [];
            }
            const found = await (await masker(policy)).find(text);
            if (found.spans.length === 0) {
                return [];
            }
            await deps.vault.commit();
            record({
                provider,
                conversationId,
                action: masking ? "refused" : "watched",
                protocol: `hooks:${channel}`,
                counts: countsOf(found.spans),
                found: found.found,
                ...opt("detail", masking ? refusal : undefined),
            });
            return masking ? kindsOf(found.spans) : [];
        },
        refusesImage: async (data, channel) => {
            const { policy, masking, watching } = await standing(provider, conversationId);
            if ((!masking && !watching) || policy.images === "allow") {
                return [];
            }
            const reading = await deps.readers.readImage(data);
            if (reading === undefined) {
                if (masking) {
                    record({
                        provider,
                        conversationId,
                        action: "refused",
                        protocol: `hooks:${channel}`,
                        counts: {},
                        found: [],
                        images: 1,
                        detail: "an image read was refused: it could not be read on this machine to be checked",
                    });
                }
                return masking ? "unreadable" : [];
            }
            const found = await (await masker(policy)).find(readingText(reading.lines));
            if (found.spans.length === 0) {
                return [];
            }
            await deps.vault.commit();
            record({
                provider,
                conversationId,
                action: masking ? "refused" : "watched",
                protocol: `hooks:${channel}`,
                counts: countsOf(found.spans),
                found: found.found,
                images: 1,
                ...opt("detail", masking ? "an image read was refused: it shows personal data" : undefined),
            });
            return masking ? kindsOf(found.spans) : [];
        },
        refusesDocument: async (data, channel) => {
            const { policy, masking, watching } = await standing(provider, conversationId);
            if (!masking && !watching) {
                return [];
            }
            const text = await deps.readers.readPdf(data);
            if (text === undefined) {
                if (masking) {
                    record({
                        provider,
                        conversationId,
                        action: "refused",
                        protocol: `hooks:${channel}`,
                        counts: {},
                        found: [],
                        documents: 1,
                        detail: "a document read was refused: it could not be read on this machine to be checked",
                    });
                }
                return masking ? "unreadable" : [];
            }
            const found = await (await masker(policy)).find(text);
            if (found.spans.length === 0) {
                return [];
            }
            await deps.vault.commit();
            record({
                provider,
                conversationId,
                action: masking ? "refused" : "watched",
                protocol: `hooks:${channel}`,
                counts: countsOf(found.spans),
                found: found.found,
                documents: 1,
                ...opt("detail", masking ? "a document read was refused: it holds personal data" : undefined),
            });
            return masking ? kindsOf(found.spans) : [];
        },
        // Synchronous by contract, so it reads the vault as loaded: forTurn loads it before handing the shield out.
        restore: (text) => restoreWith(text),
        masking: async () => (await standing(provider, conversationId)).masking,
        mcpUrl: async (url) => `${deps.loopbackBase()}${MCP_PROXY_PATH}/${await deps.tokens.sign({ provider, upstream: url, conversationId })}`,
    });
    // Restoring needs no policy: a token is looked up in the vault, never trusted for what it says (tokens.ts).
    const restoreWith = (text: string): string => createMasker({ vault: deps.vault, policy: RESTORE_POLICY, memo, recognizer: undefined }).restore(text);
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
            // A runtime the shield reads by content (the gateway, or its hooks) runs: what it reads is checked as it
            // reads it. Only one with no seam at all is decided by its runtime, since nothing it reads is ever seen.
            if (policy.mode !== "on" || shieldableRuntime(provider, harness) || (await trusted(policy, provider, conversationId))) {
                return { allowed: true };
            }
            const label = privacyProviders(await deps.capabilities()).find((entry) => entry.id === provider)?.label ?? provider;
            return { allowed: false, reason: unshieldedRefusal(label, conversationId !== undefined) };
        },
        seal: async ({ provider, harness, conversationId, prompt }) => {
            // The gateway masks this runtime's wire as it masks a turn's, so reading it here as well would log it twice.
            if (gatewayRuntime(provider, harness)) {
                return { prompt, restore: unchanged };
            }
            const reading = await read({ provider, conversationId, text: prompt, protocol: SEALED_PROTOCOL, log: "always" });
            return { prompt: reading.text, restore: reading.restore };
        },
        forTurn: async (provider, harness, conversationId) => {
            const { masking, watching } = await standing(provider, conversationId);
            if (gatewayRuntime(provider, harness) || (!masking && !watching)) {
                return undefined;
            }
            await deps.vault.load();
            return turnShield(provider, conversationId);
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
            let out = "";
            let last = 0;
            for (const span of await displaySpans(text, policy)) {
                out += `${text.slice(last, span.start)}‹${span.label.toLowerCase().replaceAll("_", " ")}›`;
                last = span.end;
            }
            return out + text.slice(last);
        },
        redactPictureForDisplay: async (data) => {
            const policy = await deps.policyStore.get();
            if (policy.mode !== "on") {
                return data;
            }
            const reading = await deps.readers.readImage(data);
            if (reading === undefined) {
                return undefined;
            }
            // Lettered with the kind alone: the token's own alphabet, and nothing a reader of the page could resolve.
            const spans = (await displaySpans(readingText(reading.lines), policy)).map(({ start, end, label }) => ({ start, end, token: label }));
            const painted = await paintRegions(data, regionsFor(reading.lines, spans, reading));
            return painted === undefined ? undefined : Buffer.from(painted.data, "base64");
        },
        learn: deps.vault.learn,
        forget: deps.vault.forget,
        sources: deps.vault.sources,
        reveal: async (tokens) => {
            await deps.vault.load();
            const values: Record<string, string> = {};
            for (const token of tokens) {
                const [, label, index, looseLabel, looseIndex] = WHOLE_TOKEN.exec(token) ?? [];
                const value =
                    label !== undefined && index !== undefined
                        ? deps.vault.resolve(label, index)
                        : looseLabel !== undefined && looseIndex !== undefined
                          ? deps.vault.resolve(looseLabel, looseIndex)
                          : undefined;
                if (value !== undefined) {
                    values[token] = value;
                }
            }
            return values;
        },
        vault: deps.vault,
        ledger: deps.ledger,
        readers: deps.readers,
        readings,
        tokens: deps.tokens,
    };
};

// Keys whose strings are structure, not words: ids and kinds a page or a client resolves by. Not a path or a name: a file
// is as often called after the person it is about as not, and a public share's own pictures are published under names
// that hold nothing (share-payload.ts), so redacting them changes nothing a page resolves.
const STRUCTURAL_KEYS = new Set(["id", "type", "kind", "source", "url", "tool", "status", "role", "mediaType"]);

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
