import type { ProviderBrand } from "@intentic/constants";
import type { AgentLoop } from "../schemas/agent.js";
import { type AgentCapabilities, CLAUDE_CODE, CODEX, CURSOR, DEVIN, GROK_BUILD, KIMI_CLI, MUSE, OPENCODE, OPENCODE_GEMINI } from "./agent-runtimes.js";

// Every fact about a provider more than one surface needs, one row each, replacing lists that drifted out of sync.
// `access` (cost) and `auth` (connection) stay separate: conflating them mis-describes Z.ai, a prepaid plan spent
// through a minted key. Adding a provider is one row here plus one registry line; everything else derives.

// What a provider costs to unlock: `free` is a real tier (Google's channel needs only a sign-in), and there is
// deliberately no `key` rung, since a raw API key against your own gateway is an `endpoint` capability, not a row here.
export type AccessKind = "free" | "subscription";

export interface ProviderAccess {
    readonly kind: AccessKind;
    // What the user connects, named the way its vendor names it: the noun every connect prompt uses.
    readonly requirement: string;
    // What connecting it lets them run, for the connect gate's one-line pitch.
    readonly runs: string;
}

// Cost order at the margin (free, subscription); not AccessKind's own order, which isn't a runtime fact.
export const ACCESS_COST: Record<AccessKind, number> = { free: 0, subscription: 1 };

// How a credential for this provider is obtained and held; every surface branches on this instead of the provider's
// name:
// - oauth: the daemon runs the sign-in and stores the tokens itself
// - translator: the bundled CLIProxyAPI holds a subscription OAuth and re-serves it behind an Anthropic endpoint
// - minted: the daemon mints the vendor's own API key from a sign-in and stores that
export type ProviderAuth =
    | { readonly kind: "oauth" }
    | { readonly kind: "translator"; readonly cliProxy: string }
    | { readonly kind: "minted"; readonly variants: readonly MintedVariant[] };

// One identity a minted provider signs into: a vendor (Z.ai) can sell one product through separate estates whose hosts
// and keys are not interchangeable. Bases live per-variant, so a turn dials the host that minted its key.
export interface MintedVariant {
    // The stored account's record of where it came from, and what login/start names; never shown.
    readonly id: string;
    // What the connect row's estate control calls it, in the vendor's own words.
    readonly label: string;
    // How this sign-in ends, deciding only the connect panel's shape:
    // - device: the daemon polls the vendor to completion, nothing to paste back
    // - redirect: the vendor sends the browser to a loopback address, and the user brings the URL back
    readonly flow: "device" | "redirect";
    // ANTHROPIC_BASE_URL for a turn minted here; no version segment, the harness appends /v1/messages itself.
    readonly anthropicBase: string;
    // Where this estate's catalog is read from: an OpenAI-compatible root, with its version segment. Also the Chat
    // Completions root a loop speaking that wire (OpenCode) sends its turns to.
    readonly catalogBase: string;
    // The estate's OpenAI Responses root, with its version segment, for a loop that speaks only that wire (Codex); absent
    // where the vendor publishes none, which keeps such a loop off this estate.
    readonly responsesBase?: string;
}

// What a vendor's own terms say about one loop serving its subscription, when there is something worth saying. Shown
// quietly (an icon and its hover card, never a banner): the owner keeps these routes by choice, and the note is there so
// nobody runs one without being able to find out.
// - unlisted: the vendor names the clients it supports and this loop is not among them; nothing on record forbids it.
// - against-terms: the vendor's terms forbid it, and have been enforced against accounts.
export interface LoopTerms {
    readonly status: "unlisted" | "against-terms";
    // The vendor's position in one sentence, for the hover card.
    readonly note: string;
    // Where the vendor says it.
    readonly source: string;
}

// One loop a provider can run on: what that pair can do, and what the vendor says about it when there is anything to say.
export interface LoopOffer {
    readonly capabilities: AgentCapabilities;
    // Absent where the vendor sanctions this loop or says nothing about it.
    readonly terms?: LoopTerms;
    // What a chip calls this loop when the provider's own name would not say which program runs it: the `vendor` loop of
    // a provider whose other loops also carry its name (Grok Build beside Grok on OpenCode). Absent: loopLabel's own.
    readonly label?: string;
    // The variant the provider's own account door (/accounts/{provider}) signs this loop in under, for a loop whose
    // credential is a sign-in of its own rather than the one the provider's other loops spend: a vendor CLI's login. An
    // account the door lists carries the same word as its `variant`, which is how a picker knows which loop it serves.
    // Absent: the loop spends the provider's default credential.
    readonly door?: string;
}

// The loops a provider runs on. `default` is what `native` (and a turn naming no loop) resolves to, and must be one of
// `offered`; offering a provider a new loop is one more entry in `offered`, plus the adapter that runs it.
export interface ProviderLoops {
    readonly default: AgentLoop;
    readonly offered: Partial<Record<AgentLoop, LoopOffer>>;
}

export interface ProviderSpec {
    // The wire id, and a reserved capability id: an installed agent capability may not reuse one.
    readonly id: string;
    // What the picker, the rail and the account tabs call it.
    readonly label: string;
    // Whose allowance a turn spends, as a sentence subject; a routed turn can spend a quota neither field names.
    readonly vendor: string;
    // Where account rows are filed under (tab, picker section, connect chip); differs from vendor only for Grok.
    readonly accountLabel: string;
    // Where the sign-in happens, not the provider's product name: what a user leaving the page should recognize.
    readonly destination: string;
    readonly brand: ProviderBrand;
    readonly access: ProviderAccess;
    readonly auth: ProviderAuth;
    // Whether a plan-limit reading is obtainable, so a blank meter is told apart from a plan that publishes none.
    readonly planLimits: boolean;
    // The loops it runs on; one offered loop means the loop is not a choice for it.
    readonly loops: ProviderLoops;
}

// Kimi's word on the two loops it documents for an API key, reached here on the translator's sign-in.
const KIMI_TRANSLATED: LoopTerms = {
    status: "unlisted",
    note: "Kimi documents OpenCode and Codex with a Kimi Code API key. Here they reach your plan through a translator's sign-in instead, which Kimi doesn't list.",
    source: "https://www.kimi.com/en/help/kimi-code/third-party-agents",
};

// satisfies checks each row's shape; as const keeps ids/auth kinds literal, so NativeProvider stays a union.
export const PROVIDER_SPECS = [
    {
        id: "claude",
        label: "Claude Code",
        vendor: "Claude",
        accountLabel: "Claude",
        destination: "Anthropic",
        brand: "claude",
        access: { kind: "subscription", requirement: "Claude subscription", runs: "Claude Code" },
        auth: { kind: "oauth" },
        planLimits: true,
        loops: { default: "claude-code", offered: { "claude-code": { capabilities: CLAUDE_CODE } } },
    },
    {
        id: "codex",
        label: "Codex",
        vendor: "ChatGPT",
        accountLabel: "ChatGPT",
        destination: "ChatGPT",
        brand: "codex",
        access: { kind: "subscription", requirement: "ChatGPT subscription", runs: "Codex" },
        auth: { kind: "translator", cliProxy: "codex" },
        planLimits: true,
        loops: {
            default: "codex",
            offered: {
                codex: { capabilities: CODEX },
                "claude-code": {
                    capabilities: CLAUDE_CODE,
                    terms: {
                        status: "unlisted",
                        note: "OpenAI lets a ChatGPT plan run in Codex and in the apps it lists for Sign in with ChatGPT (OpenCode, Pi, T3 and others). Claude Code, reached here through a translator, isn't among them.",
                        source: "https://help.openai.com/en/articles/20001542",
                    },
                },
                // The plan through the bundled translator's Responses surface, not OpenCode's own sign-in.
                opencode: {
                    capabilities: OPENCODE,
                    terms: {
                        status: "unlisted",
                        note: "OpenAI lists OpenCode among the apps a ChatGPT plan may sign in to, through OpenCode's own sign-in. Here OpenCode reaches the plan through a translator instead, which OpenAI doesn't list.",
                        source: "https://help.openai.com/en/articles/20001542",
                    },
                },
            },
        },
    },
    {
        id: "grok",
        label: "Grok",
        vendor: "xAI",
        accountLabel: "Grok",
        destination: "x.ai",
        brand: "grok",
        access: { kind: "subscription", requirement: "SuperGrok subscription", runs: "Grok" },
        // The app says grok, CLIProxyAPI says xai; Grok alone also runs natively, not just through the translator.
        auth: { kind: "translator", cliProxy: "xai" },
        planLimits: false,
        loops: {
            default: "opencode",
            offered: {
                opencode: { capabilities: OPENCODE },
                // xAI's own CLI, signed in through its own device login (not OpenCode's), and free to run on a SuperGrok
                // or X Premium plan: it is the client xAI ships for that subscription.
                vendor: { capabilities: GROK_BUILD, label: "Grok Build", door: "grok-build" },
                "claude-code": {
                    capabilities: CLAUDE_CODE,
                    terms: {
                        status: "unlisted",
                        note: "xAI turns SuperGrok sign-in on for OpenCode, Hermes, OpenClaw and Kilo Code. Claude Code, reached here through a translator, isn't among them.",
                        source: "https://x.ai/news/grok-opencode",
                    },
                },
                // The translator's xAI sign-in on its Responses surface, a sign-in of its own beside OpenCode's.
                codex: {
                    capabilities: CODEX,
                    terms: {
                        status: "unlisted",
                        note: "xAI turns SuperGrok sign-in on for OpenCode, Hermes, OpenClaw and Kilo Code. Codex, reached here through a translator, isn't among them.",
                        source: "https://x.ai/news/grok-opencode",
                    },
                },
            },
        },
    },
    {
        id: "kimi",
        label: "Kimi Code",
        vendor: "Kimi Code",
        accountLabel: "Kimi Code",
        destination: "Kimi Code",
        brand: "kimi",
        access: { kind: "subscription", requirement: "Kimi Code subscription", runs: "Kimi Code" },
        auth: { kind: "translator", cliProxy: "kimi" },
        planLimits: true,
        // Claude Code stays the default: the translator's subscription is what most sandboxes already hold. Kimi's own CLI signs
        // in with its own device login, Kimi's sanctioned client for the plan. Kimi documents Claude Code, OpenCode and Codex
        // with a Kimi Code API key; Codex and OpenCode here reach the plan through the translator's sign-in instead, which
        // Kimi doesn't list, hence their note. Claude Code predates the note and stays as it was.
        loops: {
            default: "claude-code",
            offered: {
                "claude-code": { capabilities: CLAUDE_CODE },
                vendor: { capabilities: KIMI_CLI, label: "Kimi CLI", door: "kimi-cli" },
                codex: { capabilities: CODEX, terms: KIMI_TRANSLATED },
                opencode: { capabilities: OPENCODE, terms: KIMI_TRANSLATED },
            },
        },
    },
    {
        // Labelled for the account (Google), not the model family: this channel vends Claude and GPT-OSS beside Gemini.
        id: "gemini",
        label: "Google",
        vendor: "Google",
        accountLabel: "Google",
        destination: "Google",
        brand: "gemini",
        access: { kind: "free", requirement: "Google sign-in", runs: "Gemini, Claude and GPT-OSS under Claude Code" },
        // antigravity is Google's own agent product, the name CLIProxyAPI files this credential under.
        auth: { kind: "translator", cliProxy: "antigravity" },
        planLimits: true,
        // The only routed provider without Claude Code: Google refuses any request announcing that loop.
        loops: {
            default: "opencode",
            offered: {
                opencode: {
                    capabilities: OPENCODE_GEMINI,
                    terms: {
                        status: "against-terms",
                        note: "Google's Antigravity terms don't allow its sign-in in third-party clients such as OpenCode, and Google has suspended accounts for it.",
                        source: "https://antigravity.google/terms/",
                    },
                },
            },
        },
    },
    {
        // Cursor's own runtime via Anysphere's SDK; labelled for the account since it vends several vendors' models.
        id: "cursor",
        label: "Cursor",
        vendor: "Cursor",
        accountLabel: "Cursor",
        destination: "Cursor",
        brand: "cursor",
        // Requirement names the plan, not the account: a free Cursor sign-in works but cannot run a turn here.
        access: { kind: "subscription", requirement: "Cursor Pro subscription", runs: "Cursor Agent" },
        auth: { kind: "oauth" },
        planLimits: false,
        // There is no route to Cursor but its own SDK.
        loops: { default: "vendor", offered: { vendor: { capabilities: CURSOR } } },
    },
    {
        // Cognition's Devin through its own CLI (`devin acp`); labelled for the account, since it vends many vendors'
        // models (SWE, Claude, GPT, Gemini…) under one Devin plan.
        id: "devin",
        label: "Devin",
        vendor: "Devin",
        accountLabel: "Devin",
        destination: "Devin",
        brand: "devin",
        // Free is a real tier here: a free Devin account runs turns, on the smaller list of models its plan offers.
        access: { kind: "free", requirement: "Devin account", runs: "Devin's agent on the models your plan offers" },
        // The daemon drives the CLI's own sign-in and holds the key it hands back, one per account.
        auth: { kind: "oauth" },
        // Devin publishes its quota only on its own pages and in its CLI's interactive view, nothing a key can read.
        planLimits: false,
        // The CLI is the only door, so the loop is not a choice.
        loops: { default: "vendor", offered: { vendor: { capabilities: DEVIN } } },
    },
    // The two minted providers need no translator hop: each has its own endpoint for the minted key. Meta's key is a Muse
    // Code key, so its own loop is Muse Code; Z.ai's runs under Claude Code against its Anthropic Messages endpoint.
    {
        id: "meta",
        label: "Meta",
        vendor: "Meta",
        accountLabel: "Meta",
        destination: "Meta",
        brand: "meta",
        // A subscription like the rest: the device sign-in mints a plan key, and the plan is what a turn spends.
        access: { kind: "subscription", requirement: "Muse Code subscription", runs: "Muse Spark in Muse Code" },
        auth: {
            kind: "minted",
            // Preserve the minted variant id because stored accounts reference it.
            variants: [
                {
                    id: "meta",
                    label: "Meta",
                    // The textbook device flow (RFC 8628): a code read off the card, and a poll that returns nothing
                    // here.
                    flow: "device",
                    // No version segment here: /v1/messages is appended by the harness, beside the catalog's OpenAI
                    // surface.
                    anthropicBase: "https://api.meta.ai",
                    catalogBase: "https://api.meta.ai/v1",
                },
            ],
        },
        // No quota surface a minted key can read: the row shows no meter and says so, not an empty one reading as zero.
        planLimits: false,
        // Muse Code is the use Meta's terms sanction for the key, so it says nothing; Claude Code stays on offer, quietly noted.
        loops: {
            default: "muse",
            offered: {
                muse: { capabilities: MUSE },
                "claude-code": {
                    capabilities: CLAUDE_CODE,
                    terms: {
                        status: "against-terms",
                        note: "Meta's terms say a Muse Code subscription key is for use with Muse Code only. Here it runs under Claude Code.",
                        source: "https://dev.meta.ai/docs/muse-code/subscriptions",
                    },
                },
            },
        },
    },
    {
        id: "zai",
        label: "Z.ai",
        vendor: "Z.ai",
        accountLabel: "Z.ai",
        destination: "Z.ai",
        brand: "zai",
        // A prepaid GLM Coding Plan with a watched quota; the sign-in mints its own key, so requirement names the plan.
        access: { kind: "subscription", requirement: "Z.ai GLM Coding Plan", runs: "GLM under Claude Code" },
        auth: {
            kind: "minted",
            // Two estates, each its own base (a key from one is refused by the other); root is the coding-plan path.
            variants: [
                {
                    id: "zai",
                    // Cased as the vendor cases it, matching how the row itself is titled elsewhere on screen.
                    label: "Z.ai international",
                    // zcode.z.ai mediates the callback itself: the daemon polls it, nothing dead-ends in the user's
                    // browser.
                    flow: "device",
                    anthropicBase: "https://api.z.ai/api/anthropic",
                    catalogBase: "https://api.z.ai/api/coding/paas/v4",
                    // Z.ai's dedicated Responses endpoint for Codex (docs.z.ai/devpack/tool/codex).
                    responsesBase: "https://api.z.ai/api/v1",
                },
                {
                    id: "bigmodel",
                    label: "BigModel (中国大陆)",
                    // BigModel refuses that callback; a loopback redirect dead-ends the page, and the user brings the
                    // grant back.
                    flow: "redirect",
                    anthropicBase: "https://open.bigmodel.cn/api/anthropic",
                    catalogBase: "https://open.bigmodel.cn/api/coding/paas/v4",
                    // BigModel's equivalent (docs.bigmodel.cn/cn/coding-plan/tool/codex).
                    responsesBase: "https://open.bigmodel.cn/api/v1",
                },
            ],
        },
        planLimits: false,
        // The GLM Coding Plan lists Claude Code, Codex and OpenCode among its tools, each on the minted key aimed at the
        // estate's own endpoints: Anthropic Messages, Responses and Chat Completions respectively.
        loops: {
            default: "claude-code",
            offered: { "claude-code": { capabilities: CLAUDE_CODE }, codex: { capabilities: CODEX }, opencode: { capabilities: OPENCODE } },
        },
    },
] as const satisfies readonly ProviderSpec[];

type Spec = (typeof PROVIDER_SPECS)[number];

// The agent runtimes the daemon can serve; a native id is reserved, `endpoint/<id>` or any other value names an
// installed capability instead. Derived from the table and a union of its ids, so the wire vocabulary can't drift.
export type NativeProvider = Spec["id"];
export const NATIVE_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.map((spec) => spec.id);

const BY_ID = new Map<string, ProviderSpec>(PROVIDER_SPECS.map((spec) => [spec.id, spec] as const));

// The row for a provider id, or nothing for an ACP agent, an endpoint, or a typo: the one lookup every table and
// surface goes through.
export const providerSpec = (provider: string): ProviderSpec | undefined => BY_ID.get(provider);

// The native providers a list of ids names, in its order and once each; anything else in it (an endpoint, a typo, a
// provider a newer build knows) is dropped rather than refusing the list. Takes a comma-separated string or an array of
// them, the way a query string hands it over: the desktop app's `?found=claude,codex` names the providers it found
// signed in on the computer it runs on.
export const nativeProvidersIn = (value: string | readonly (string | null)[] | null | undefined): NativeProvider[] => {
    const raw = [value].flat().filter((entry) => entry !== null && entry !== undefined);
    const found: NativeProvider[] = [];
    for (const id of raw.flatMap((entry) => entry.split(",")).map((entry) => entry.trim())) {
        const provider = NATIVE_PROVIDERS.find((candidate) => candidate === id);
        if (provider !== undefined && !found.includes(provider)) {
            found.push(provider);
        }
    }
    return found;
};

// Providers whose model runs under Claude Code through the bundled translator (CLIProxyAPI); claude is absent, native
// Anthropic OAuth serves it directly. Narrowed off the auth kind so tables built on this move with it.
export type TranslatorProvider = Extract<Spec, { auth: { kind: "translator" } }>["id"];
export const TRANSLATOR_PROVIDERS: readonly TranslatorProvider[] = PROVIDER_SPECS.filter(
    (spec): spec is Extract<Spec, { auth: { kind: "translator" } }> => spec.auth.kind === "translator",
).map((spec) => spec.id);

// Providers whose sign-in mints the vendor's own API key, served straight off that vendor's own Anthropic Messages
// endpoint.
export type MintedProvider = Extract<Spec, { auth: { kind: "minted" } }>["id"];
export const MINTED_PROVIDERS: readonly MintedProvider[] = PROVIDER_SPECS.filter(
    (spec): spec is Extract<Spec, { auth: { kind: "minted" } }> => spec.auth.kind === "minted",
).map((spec) => spec.id);

// This provider's CLIProxyAPI id, where it has one; not always ours (grok/xai, gemini/antigravity).
export const cliProxyIdOf = (provider: string): string | undefined => {
    const auth = providerSpec(provider)?.auth;
    return auth?.kind === "translator" ? auth.cliProxy : undefined;
};

// Every estate a minted provider can sign into, in connect-row order, or nothing if it is not minted. The head is the
// default a variant-less login/start gets.
export const mintedVariants = (provider: string): readonly MintedVariant[] | undefined => {
    const auth = providerSpec(provider)?.auth;
    return auth?.kind === "minted" ? auth.variants : undefined;
};

// The whole estate (bases and flow together), so a base is never read without its sibling. An absent id defaults to the
// head; a name matching no variant is undefined, not the default, so a lost variant surfaces honestly.
export const mintedVariant = (provider: string, variant?: string): MintedVariant | undefined => {
    const variants = mintedVariants(provider);
    if (variants === undefined) {
        return undefined;
    }
    return variant === undefined || variant === "" ? variants[0] : variants.find((entry) => entry.id === variant);
};
