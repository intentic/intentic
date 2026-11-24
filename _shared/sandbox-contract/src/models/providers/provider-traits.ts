// WHAT EACH NATIVE PROVIDER IS, beyond what its spec row (provider-specs.ts) says it costs and how it signs in: one row per
// provider of every fact a surface used to answer with `provider === "x"`. A reader asks the trait ("is Anthropic itself on
// the wire", "does its key travel through the hub"), never the name, so a new provider is one row the compiler makes
// complete (`satisfies Record<NativeProvider, …>`) instead of a branch hunt across the editor and the daemon.
// Pure data with no schema, so the contract lock does not see it.
import type { AgentLoop } from "../../schemas/agent.js";
import type { NativeProvider } from "../provider-specs.js";

// Who a model provider's own hosts belong to, for the compliance report's data-flow list. A region is given only where the
// operator publishes one.
export interface ProviderDestination {
    readonly hosts: readonly string[];
    readonly operator: string;
    readonly region?: string;
    readonly thirdCountry: boolean;
}

export interface ProviderTraits {
    // Its account is a key that does not rotate, so it may travel through the connections hub (schemas/connection-hub.ts).
    readonly hubAccount: boolean;
    // Its own hosts and their operator, for the compliance report; absent where the report names none.
    readonly destination?: ProviderDestination;
    // Anthropic itself serves the wire, not a vendor wearing Anthropic's API: its prompt cache lifetime is published, the
    // CLI's tool search and fast mode reach it, and a cold-cache trim is worth making.
    readonly firstPartyAnthropic: boolean;
    // The reasoning ladder its models climb before a catalog says otherwise. `anthropic` claims `max` in the floor, and its
    // API refuses `max` with thinking explicitly off.
    readonly effortScale: "anthropic" | "standard";
    // It publishes an extended-thinking switch a person may turn off.
    readonly thinkingToggle: boolean;
    // An account an admin held back is probed again for its seat (the seat check), so a lifted hold is found.
    readonly seatProbe: boolean;
    // Which account an unnamed pick lands on depends on the model, so an unnamed model is judged as the catalog's default.
    readonly placesByModel: boolean;
    // How the budget planner sees its ready accounts: each one a child may be placed on, or one pool the gateway spends.
    readonly childPlacement: "per-account" | "pooled";
    // A loop of a translator provider that spends the provider's own default sign-in (held at its own door) rather than the
    // translator's subscription: OpenCode holds Grok's xAI account. That loop holds one such account.
    readonly ownSignInLoop?: AgentLoop;
    // How the translator's sign-in for it runs, for a translator provider: a device code, a redirect the vendor's page
    // ends on, or a device login that may instead end on a loopback redirect a paired computer catches.
    readonly translatorSignIn?: "device" | "redirect" | "device-or-loopback";
    // Its sign-in must also discover a billing project, and a credential filed without one cannot run a turn.
    readonly needsProject: boolean;
    // Its vendor refuses requests that announce Claude Code, so the gateway scrubs those phrases on the way out.
    readonly refusesClaudeCodeMentions: boolean;
    // The wire its translator route speaks to OpenCode: Codex's own Responses surface, or Chat Completions.
    readonly opencodeWire: "openai-responses" | "openai-chat";
    // What the person brings back from a paste-back sign-in, named as the vendor's page names it.
    readonly pasteBack: "code" | "token";
    // Its device sign-in opens with the code already filled in, so there is nothing to type.
    readonly signInCodePrefilled: boolean;
}

const plain = {
    hubAccount: false,
    firstPartyAnthropic: false,
    effortScale: "standard",
    thinkingToggle: false,
    seatProbe: false,
    placesByModel: false,
    childPlacement: "pooled",
    needsProject: false,
    refusesClaudeCodeMentions: false,
    opencodeWire: "openai-chat",
    pasteBack: "code",
    signInCodePrefilled: false,
} as const;

// In PROVIDER_SPECS' order but for Z.ai before Meta: a derived list keeps the table's order, and HUB_ACCOUNT_PROVIDERS'
// wire enum has always listed zai first (the contract lock would see the swap).
export const PROVIDER_TRAITS = {
    claude: {
        ...plain,
        destination: { hosts: ["api.anthropic.com"], operator: "Anthropic PBC", region: "US", thirdCountry: true },
        firstPartyAnthropic: true,
        effortScale: "anthropic",
        thinkingToggle: true,
        seatProbe: true,
        placesByModel: true,
        childPlacement: "per-account",
    },
    codex: {
        ...plain,
        destination: { hosts: ["chatgpt.com", "api.openai.com"], operator: "OpenAI", region: "US", thirdCountry: true },
        translatorSignIn: "device-or-loopback",
        opencodeWire: "openai-responses",
    },
    grok: {
        ...plain,
        destination: { hosts: ["api.x.ai"], operator: "xAI", region: "US", thirdCountry: true },
        ownSignInLoop: "opencode",
        translatorSignIn: "device",
        signInCodePrefilled: true,
    },
    kimi: {
        ...plain,
        destination: { hosts: ["api.kimi.com"], operator: "Moonshot AI", region: "CN", thirdCountry: true },
        translatorSignIn: "device",
    },
    gemini: { ...plain, translatorSignIn: "redirect", needsProject: true, refusesClaudeCodeMentions: true },
    cursor: { ...plain, hubAccount: true, placesByModel: true },
    devin: { ...plain, hubAccount: true, pasteBack: "token" },
    zai: { ...plain, hubAccount: true, destination: { hosts: ["api.z.ai"], operator: "Z.ai", thirdCountry: true } },
    meta: { ...plain, hubAccount: true, destination: { hosts: ["api.meta.ai"], operator: "Meta Platforms", region: "US", thirdCountry: true } },
} as const satisfies Record<NativeProvider, ProviderTraits>;

type Table = typeof PROVIDER_TRAITS;

// The providers whose row matches `P`, as a type: `ProvidersWhere<{ hubAccount: true }>` is "cursor" | "devin" | ….
export type ProvidersWhere<P> = { [K in keyof Table]: Table[K] extends P ? K : never }[keyof Table];

// The table's own keys, which `satisfies` holds to exactly the native providers.
// SAFETY: Object.keys of a table that satisfies Record<NativeProvider, …> lists native providers and nothing else.
const PROVIDERS = Object.keys(PROVIDER_TRAITS) as NativeProvider[];

// The providers whose row passes `test`, in the table's order.
export const providersWhere = (test: (traits: ProviderTraits) => boolean): readonly NativeProvider[] =>
    PROVIDERS.filter((provider) => test(PROVIDER_TRAITS[provider]));

// One provider's row, or undefined for anything else (an endpoint, an ACP agent, a provider a newer build knows).
export const providerTraits = (provider: string): ProviderTraits | undefined => {
    const found = PROVIDERS.find((candidate) => candidate === provider);
    return found === undefined ? undefined : PROVIDER_TRAITS[found];
};

// Whether a provider's row has this trait on; false for a string no native provider answers to.
export const providerHas = (provider: string, trait: BooleanTrait): boolean => providerTraits(provider)?.[trait] === true;

type BooleanTrait = { [K in keyof ProviderTraits]-?: ProviderTraits[K] extends boolean ? K : never }[keyof ProviderTraits];

// The providers whose row matches `P`, as a list typed by them. `P` and `test` must say the same thing; the contract's test
// pins every list built with this to its literal.
const providersTyped = <P>(test: (traits: ProviderTraits) => boolean): readonly ProvidersWhere<P>[] =>
    // SAFETY: the caller's `test` selects the rows `P` describes, pinned per list in provider-traits.test.ts.
    providersWhere(test) as readonly ProvidersWhere<P>[];

// The providers whose static key may travel through the connections hub, typed by them.
export type HubProvider = ProvidersWhere<{ readonly hubAccount: true }>;
export const HUB_PROVIDERS = providersTyped<{ readonly hubAccount: true }>((traits) => traits.hubAccount);

// The providers whose unnamed account pick is judged for the model, typed by them.
export type ModelPlacedProvider = ProvidersWhere<{ readonly placesByModel: true }>;
export const isModelPlaced = (provider: string): provider is ModelPlacedProvider => providerHas(provider, "placesByModel");
