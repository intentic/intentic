import { errorMessage } from "@intentic/base/errors";
import type { AgentHarness } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type {
    PersonalDataClass,
    PrivacyKnownSource,
    PrivacyKnownValue,
    PrivacyPreview,
    PrivacyShieldPolicy,
    PrivacyShieldStatus,
} from "@intentic/sandbox-contract/schemas/privacy";
import { type PrivacyBypass, type PrivacyRoute, type ShieldVerdict, shieldVerdict } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { type ClassCounts, createMasker, createMaskMemo, type EntityRecognizer, type Masker } from "./masker.js";
import type { PrivacyImageArchive } from "./privacy-images.js";
import { type EgressNote, noteEgress, type PrivacyLedger } from "./privacy-ledger.js";
import type { PrivacyPolicyStore } from "./privacy-policy.js";
import { isLocalProvider, privacyProviders, runtimeRoute } from "./privacy-trust.js";
import type { PrivacyVault } from "./privacy-vault.js";
import type { LocalReaders } from "./readers.js";
import type { GatewaySession, SessionTokens } from "./gateway/session-token.js";
import { createReadingMemo, type ReadingMemo } from "./gateway/request-shield.js";
import { paintRegions, readingText, regionsFor } from "./image-mask.js";
import { TOKEN_LABEL, TOKEN_SOURCE } from "./tokens.js";

// The privacy shield as the rest of the daemon sees it: the owner's policy, the one verdict on bytes bound for a
// provider (sandbox-contract privacy-egress.ts) as every place they leave by asks it, the base URL a runtime is pointed
// at, and the masker every other exit (push, shares) borrows. The gateway route that does the masking on the wire reads
// its parts from here.

// Where bytes for a provider would leave, as the shield is asked about them; whether the provider is a model this machine
// serves is the shield's to know.
export interface EgressAsk {
    readonly provider: string;
    readonly conversationId?: string | undefined;
    readonly route: PrivacyRoute;
}

// The verdict, and the policy in force it was read under, which the masker for those bytes is built from.
export interface ShieldDecision {
    readonly policy: PrivacyShieldPolicy;
    readonly verdict: ShieldVerdict;
}

// A sealed request (agent/providers/agent-request.ts `policy.sealed`): its prompt is everything the model reads, since
// it carries no tools, reads no file and continues no session. Who it goes to, for the verdict it is read under.
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
// `hooks`, agent-runtimes.ts): each channel hands its text here before the model can read it. The verdict is read on
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
    // Whether masking is in force right now: the verdict is to mask. False while it watches.
    readonly masking: () => Promise<boolean>;
    // Where the runtime should call an MCP server instead of `url`: the masking proxy, which restores tokens in what the
    // model sends and masks what the server answers (gateway/mcp-route.ts).
    readonly mcpUrl: (url: string) => Promise<string>;
}

export interface PrivacyShield {
    readonly policy: () => Promise<PrivacyShieldPolicy>;
    readonly setPolicy: (policy: PrivacyShieldPolicy) => Promise<void>;
    readonly status: () => Promise<PrivacyShieldStatus>;
    // THE verdict on bytes leaving by a route, read fresh: pass, watch, mask or refuse. Throws when the policy can't be
    // read; a seam that acts on the verdict refuses the bytes then rather than sending them as they are.
    readonly decide: (egress: EgressAsk) => Promise<ShieldDecision>;
    // Why bytes leaving by a route may not go, in the words a turn ends with, or nothing: they may (masked, watched or as
    // they are). A policy that can't be read refuses, since the shield may be on and what leaves cannot be taken back.
    readonly refusal: (egress: EgressAsk) => Promise<string | undefined>;
    // A sealed request, read for what it holds rather than refused for its runtime: sent as it is when the gateway
    // already stands in front of that runtime or the verdict passes it, masked here, with the restore that reads tokens in
    // the answer back, when the verdict masks. Never refuses: the whole request is in hand. Throws when the policy can't
    // be read or masking fails, which refuses the request rather than sending it as it is.
    readonly seal: (request: SealedRequest) => Promise<SealedPrompt>;
    // The shield for one turn on a hooked runtime (TurnShield), read by the same reader `seal` reads with; undefined when
    // there is nothing to read for: the runtime is not a hooked one, or the verdict passes the provider.
    readonly forTurn: (provider: string, harness: AgentHarness, conversationId?: string) => Promise<TurnShield | undefined>;
    // The base URL a runtime should send its model requests to instead of `upstream`; undefined while the shield is off,
    // so a sandbox that never turned it on sends nothing through the daemon.
    readonly baseUrlFor: (session: GatewaySession) => Promise<string | undefined>;
    // A masker for the policy in force; cheap, since its memo and vault are shared.
    readonly masker: (policy: PrivacyShieldPolicy) => Promise<Masker>;
    // The log's one writer (privacy-ledger.ts), for the seams that act on a verdict.
    readonly note: (note: EgressNote) => void;
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
    // What the policy as saved would find in a text, and what found each, whatever the switch says: for the owner
    // trying their lists and rules. Gives no token and keeps nothing.
    readonly preview: (text: string) => Promise<PrivacyPreview>;
    readonly vault: PrivacyVault;
    readonly ledger: PrivacyLedger;
    // The images it painted over, each beside the picture it was, for the owner's peek (privacy.image).
    readonly images: PrivacyImageArchive;
    readonly readers: LocalReaders;
    readonly readings: ReadingMemo;
    readonly tokens: SessionTokens;
}

export interface PrivacyShieldDeps {
    readonly policyStore: PrivacyPolicyStore;
    readonly vault: PrivacyVault;
    readonly ledger: PrivacyLedger;
    readonly images: PrivacyImageArchive;
    readonly readers: LocalReaders;
    readonly tokens: SessionTokens;
    readonly capabilities: () => Promise<readonly Capability[]>;
    // The daemon's loopback base, where a runtime reaches the gateway route.
    readonly loopbackBase: () => string;
    // The local name model, when installed and asked for; undefined otherwise.
    readonly recognizer: () => Promise<EntityRecognizer | undefined>;
    // Whether that model is installed, for the status.
    readonly recognizerInstalled: () => Promise<boolean>;
    // Where a rule of the owner's that cannot run, and a log line that could not be written, are said.
    readonly warn?: (message: string) => void;
}

export const GATEWAY_PATH = "/privacy/gateway";
export const MCP_PROXY_PATH = "/privacy/mcp";

// Why bytes that would pass no seam were turned away, by where they would go. Decided by the route alone, before a word
// is read, so each sentence says that first: read as a finding (2026-10-02), a refusal sent the owner looking for
// personal data in a message that held none.
const refusalSentence = (route: PrivacyBypass, label: string, inConversation: boolean): string => {
    const trust = inConversation
        ? `let ${label} read this conversation as it is from the strip above the composer, or trust it everywhere in Sandbox ▸ Privacy shield`
        : `trust ${label} in Sandbox ▸ Privacy shield`;
    switch (route) {
        case "runtime":
            return [
                `The privacy shield turned ${label} away before reading anything: nothing in what you sent was flagged.`,
                `${label}'s agent reads files and command output on its own and sends them to its provider on a wire the shield can't read, so it can't mask personal data on the way, and an untrusted ${label} does not run while the shield is on.`,
                `Pick a provider the shield covers, or ${trust}.`,
            ].join(" ");
        case "runner":
            return `The privacy shield is on, and a runner would call ${label} from its own machine, past the shield: nothing in what you sent was flagged. Run this conversation here, or ${trust}.`;
        case "own-key":
            return `The privacy shield is on, and ${label} here would call its provider with the container's own key, past the shield. Connect your subscription so it runs through the translator, or ${trust}.`;
        case "shared-server":
            return "The privacy shield was turned on while other conversations were running on the shared OpenCode server, which was started before it. Send again once they finish, and this one runs behind the shield.";
    }
};

// The kinds a reading holds, each once, in the order they sit in the text. Read off the spans rather than the counts:
// a text the memo has seen counts nothing again (masker.ts), and a file opened twice must be refused twice.
const kindsOf = (spans: readonly { readonly class: PersonalDataClass }[]): PersonalDataClass[] => [...new Set(spans.map((span) => span.class))];

// The counts a refusal is logged with: what this reading holds, whether or not the memo had seen it.
const countsOf = (spans: readonly { readonly class: PersonalDataClass }[]): ClassCounts => {
    const counts: ClassCounts = {};
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

// What a verdict has the shield do with bytes it can read: read them, and whether to mask what it finds.
const reading = (verdict: ShieldVerdict): "mask" | "watch" | undefined => (verdict.kind === "mask" || verdict.kind === "watch" ? verdict.kind : undefined);

// What a place that keeps no token shows in place of each finding: its kind.
const labelOf = (kind: PersonalDataClass): string => TOKEN_LABEL[kind].toLowerCase().replaceAll("_", " ");

export const createPrivacyShield = (deps: PrivacyShieldDeps): PrivacyShield => {
    const memo = createMaskMemo();
    const readings = createReadingMemo();
    const warn = deps.warn ?? (() => undefined);
    const note = (line: EgressNote): void => noteEgress(deps.ledger, line, warn);
    const masker = async (policy: PrivacyShieldPolicy): Promise<Masker> =>
        createMasker({ vault: deps.vault, policy, memo, recognizer: policy.names === "model" ? await deps.recognizer() : undefined, warn });
    // The one verdict, read fresh: a grant or a trust made between two requests holds from the next one.
    const decide = async (egress: EgressAsk): Promise<ShieldDecision> => {
        const policy = await deps.policyStore.get();
        const local = policy.mode !== "off" && isLocalProvider(egress.provider, await deps.capabilities());
        return { policy, verdict: shieldVerdict(policy, { ...egress, local }) };
    };
    // THE READER every text bound for a provider the gateway does not stand in front of goes through: a sealed request's
    // prompt, and each channel of a hooked runtime's turn. Masked, read and logged, or left alone, as the verdict says.
    // `log` says when a reading earns a line: a sealed request is a request and always does; a channel of a turn speaks
    // often and logs only what it found.
    const read = async (
        egress: EgressAsk,
        text: string,
        line: { readonly protocol: string; readonly log: "always" | "found" },
    ): Promise<SealedPrompt> => {
        const { policy, verdict } = await decide(egress);
        const how = reading(verdict);
        if (how === undefined || text === "") {
            return { prompt: text, restore: unchanged };
        }
        const shield = await masker(policy);
        const found = how === "mask" ? await shield.mask(text) : await shield.find(text);
        // The tokens the provider is about to read must be on disk before it reads them, as on the wire.
        await deps.vault.commit();
        if (line.log === "always" || found.found.length > 0) {
            note({ ...egress, conversationId: egress.conversationId, verdict, action: how === "mask" ? "masked" : "watched", protocol: line.protocol, counts: found.counts, replacements: found.found });
        }
        // Watching sends the text as it came, so nothing in the answer is a token this reading gave out.
        return "text" in found ? { prompt: found.text, restore: shield.restore } : { prompt: text, restore: unchanged };
    };
    const turnShield = (provider: string, conversationId: string | undefined): TurnShield => {
        const egress = { provider, conversationId, route: "hooks" } as const;
        // A read the runtime can only allow or refuse: what `look` reads of it checked under the verdict in force and
        // logged, and the kinds that refuse it while the shield masks. `look` answers undefined for what could not be read
        // on this machine to be checked, which refuses it as surely, since it would otherwise go unchecked.
        const judge = async (
            channel: string,
            look: (policy: PrivacyShieldPolicy) => Promise<string | undefined>,
            line: { readonly refused: string; readonly unreadable?: string; readonly images?: number; readonly documents?: number },
        ): Promise<readonly PersonalDataClass[] | "unreadable"> => {
            const { policy, verdict } = await decide(egress);
            const how = reading(verdict);
            if (how === undefined) {
                return [];
            }
            const counted = { images: line.images, documents: line.documents };
            const text = await look(policy);
            if (text === undefined) {
                if (how === "mask") {
                    note({ ...egress, ...counted, verdict, action: "refused", protocol: `hooks:${channel}`, detail: line.unreadable });
                }
                return how === "mask" ? "unreadable" : [];
            }
            const found = await (await masker(policy)).find(text);
            if (found.spans.length === 0) {
                return [];
            }
            await deps.vault.commit();
            note({
                ...egress,
                ...counted,
                verdict,
                action: how === "mask" ? "refused" : "watched",
                protocol: `hooks:${channel}`,
                counts: countsOf(found.spans),
                replacements: found.found,
                detail: how === "mask" ? line.refused : undefined,
            });
            return how === "mask" ? kindsOf(found.spans) : [];
        };
        return {
            provider,
            conversationId,
            mask: async (text, channel) => (await read(egress, text, { protocol: `hooks:${channel}`, log: "found" })).prompt,
            // A text in hand is always readable, so `judge` never answers unreadable for it.
            refuses: async (text, channel, refused) => {
                const kinds = await judge(channel, async () => text, { refused });
                return kinds === "unreadable" ? [] : kinds;
            },
            refusesImage: (data, channel) =>
                judge(
                    channel,
                    async (policy) => {
                        if (policy.images === "allow") {
                            return "";
                        }
                        const image = await deps.readers.readImage(data);
                        return image === undefined ? undefined : readingText(image.lines);
                    },
                    {
                        refused: "an image read was refused: it shows personal data",
                        unreadable: "an image read was refused: it could not be read on this machine to be checked",
                        images: 1,
                    },
                ),
            refusesDocument: (data, channel) =>
                judge(channel, () => deps.readers.readPdf(data), {
                    refused: "a document read was refused: it holds personal data",
                    unreadable: "a document read was refused: it could not be read on this machine to be checked",
                    documents: 1,
                }),
            // Synchronous by contract, so it reads the vault as loaded: forTurn loads it before handing the shield out.
            restore: (text) => restoreWith(text),
            masking: async () => (await decide(egress)).verdict.kind === "mask",
            mcpUrl: async (url) => `${deps.loopbackBase()}${MCP_PROXY_PATH}/${await deps.tokens.sign({ provider, upstream: url, conversationId })}`,
        };
    };
    // Restoring needs no policy: a token is looked up in the vault, never trusted for what it says (tokens.ts).
    const restoreWith = (text: string): string =>
        createMasker({ vault: deps.vault, policy: RESTORE_POLICY, memo, recognizer: undefined }).restore(text);
    // Where each finding sits in a text for a place that keeps no token, under the policy in force; none while it is off.
    const findings = async (text: string) => {
        const policy = await deps.policyStore.get();
        return policy.mode === "on" ? (await masker(policy)).inspect(text) : undefined;
    };
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
        decide,
        refusal: async (egress) => {
            try {
                const { verdict } = await decide(egress);
                if (verdict.kind !== "refuse") {
                    return undefined;
                }
                const label = privacyProviders(await deps.capabilities()).find((entry) => entry.id === egress.provider)?.label ?? egress.provider;
                return refusalSentence(verdict.route, label, egress.conversationId !== undefined);
            } catch (error) {
                return `The privacy shield's policy could not be read, so nothing was sent. ${errorMessage(error)}`;
            }
        },
        // The gateway reads this runtime's wire as it reads a turn's, so reading the prompt here as well would log it twice.
        seal: async ({ provider, harness, conversationId, prompt }) =>
            runtimeRoute(provider, harness) === "gateway"
                ? { prompt, restore: unchanged }
                : read({ provider, conversationId, route: "sealed" }, prompt, { protocol: SEALED_PROTOCOL, log: "always" }),
        forTurn: async (provider, harness, conversationId) => {
            if (runtimeRoute(provider, harness) !== "hooks" || reading((await decide({ provider, conversationId, route: "hooks" })).verdict) === undefined) {
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
        masker,
        note,
        redactForDisplay: async (text) => {
            const spans = await findings(text);
            if (spans === undefined) {
                return text;
            }
            let out = "";
            let last = 0;
            for (const span of spans) {
                out += `${text.slice(last, span.start)}‹${labelOf(span.class)}›`;
                last = span.end;
            }
            return out + text.slice(last);
        },
        redactPictureForDisplay: async (data) => {
            if ((await deps.policyStore.get()).mode !== "on") {
                return data;
            }
            const image = await deps.readers.readImage(data);
            if (image === undefined) {
                return undefined;
            }
            // Lettered with the kind alone: the token's own alphabet, and nothing a reader of the page could resolve.
            const spans = ((await findings(readingText(image.lines))) ?? []).map(({ start, end, class: kind }) => ({ start, end, token: TOKEN_LABEL[kind] }));
            const painted = await paintRegions(data, regionsFor(image.lines, spans, image));
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
        preview: async (text) => ({ spans: await (await masker(await deps.policyStore.get())).inspect(text) }),
        vault: deps.vault,
        ledger: deps.ledger,
        images: deps.images,
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
