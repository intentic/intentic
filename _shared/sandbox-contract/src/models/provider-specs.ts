import type { ProviderBrand } from "@intentic/constants";
import { type AgentCapabilities, CLAUDE_CODE, CODEX, CURSOR, OPENCODE, OPENCODE_GEMINI } from "./agent-runtimes.js";

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
    // Where this estate's catalog is read from: an OpenAI-compatible root, with its version segment.
    readonly catalogBase: string;
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
    // The two runtimes this provider runs on; equal records here mean the harness is not a real choice for it.
    readonly runtimes: { readonly native: AgentCapabilities; readonly claudeCode: AgentCapabilities };
}

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
        // Claude has no second runtime: the harness axis is not a choice here.
        runtimes: { native: CLAUDE_CODE, claudeCode: CLAUDE_CODE },
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
        runtimes: { native: CODEX, claudeCode: CLAUDE_CODE },
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
        runtimes: { native: OPENCODE, claudeCode: CLAUDE_CODE },
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
        // Kimi has no native runtime: it exists only under the Claude Code loop, on both harnesses.
        runtimes: { native: CLAUDE_CODE, claudeCode: CLAUDE_CODE },
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
        // The only routed provider that ignores harness: Google refuses any request announcing the Claude Code loop.
        runtimes: { native: OPENCODE_GEMINI, claudeCode: OPENCODE_GEMINI },
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
        // Cursor ignores harness too: there is no route to it but its own SDK.
        runtimes: { native: CURSOR, claudeCode: CURSOR },
    },
    // The two minted providers need no new runtime or translator hop: each has its own Anthropic Messages endpoint.
    {
        id: "meta",
        label: "Meta",
        vendor: "Meta",
        accountLabel: "Meta",
        destination: "Meta",
        brand: "meta",
        // A subscription like the rest: the device sign-in mints a plan key, and the plan is what a turn spends.
        access: { kind: "subscription", requirement: "Muse Code subscription", runs: "Muse Spark under Claude Code" },
        auth: {
            kind: "minted",
            // One estate, no choice to offer; the id still exists since a stored account records which variant minted
            // it.
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
        runtimes: { native: CLAUDE_CODE, claudeCode: CLAUDE_CODE },
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
                },
                {
                    id: "bigmodel",
                    label: "BigModel (中国大陆)",
                    // BigModel refuses that callback; a loopback redirect dead-ends the page, and the user brings the
                    // grant back.
                    flow: "redirect",
                    anthropicBase: "https://open.bigmodel.cn/api/anthropic",
                    catalogBase: "https://open.bigmodel.cn/api/coding/paas/v4",
                },
            ],
        },
        planLimits: false,
        runtimes: { native: CLAUDE_CODE, claudeCode: CLAUDE_CODE },
    },
] as const satisfies readonly ProviderSpec[];

type Spec = (typeof PROVIDER_SPECS)[number];

// The agent runtimes the daemon can serve; a native id is reserved, `endpoint/<id>` or any other value names an
// installed capability instead. Derived from the table and a union of six names, so the wire vocabulary can't drift.
export type NativeProvider = Spec["id"];
export const NATIVE_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.map((spec) => spec.id);

const BY_ID = new Map<string, ProviderSpec>(PROVIDER_SPECS.map((spec) => [spec.id, spec] as const));

// The row for a provider id, or nothing for an ACP agent, an endpoint, or a typo: the one lookup every table and
// surface goes through.
export const providerSpec = (provider: string): ProviderSpec | undefined => BY_ID.get(provider);

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
