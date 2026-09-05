import type { ProviderBrand } from "@intentic/constants";
import { type AgentCapabilities, CLAUDE_CODE, CODEX, CURSOR, OPENCODE, OPENCODE_GEMINI } from "./agent-runtimes.js";

/* EVERY FACT ABOUT A PROVIDER THAT MORE THAN ONE SURFACE NEEDS, one row each, and the reason this file exists
 * rather than the nine lists it replaced.
 *
 * The same six names used to be written out in ten places: the wire vocabulary, the picker's labels, the access
 * table, the vendor table, the plan-limit list, the translator's provider enum and its accounts schema, the
 * daemon's CLIProxyAPI id map and its requirement strings, and the web's tabs, account seed and readiness
 * branches. Six of those were `Record<NativeProvider, …>` and could not silently miss a provider; the rest were
 * arrays and if-chains, and those are the ones that DID. Cursor shipped absent from the secrets inventory for a
 * release because an enumeration does not know what it is missing, which is the same failure the daemon's
 * ProviderModule registry was built to end on its side of the wire. This is that fix for the other side.
 *
 * WHAT A ROW IS, and the two axes it deliberately keeps apart:
 *
 *   `access` is what a turn COSTS: free, or an already-paid subscription with a quota. It is what the picker
 *            badges, what orders the locked band, and what quick-model spends against (ACCESS_COST).
 *   `auth`   is what the user CONNECTS: an OAuth account this daemon stores, a subscription the bundled
 *            translator holds, or a sign-in that mints the vendor's own API key.
 *
 * They are not the same question and conflating them is how Z.ai would have been described wrongly whichever
 * single word was picked: its cost is a prepaid coding plan, and the credential that plan is spent through is an
 * API key its sign-in mints. Keeping the axes apart is what lets a surface ask the one it actually needs.
 *
 * `brand` is typed against the marks in @intentic/constants, so a provider added without a logo does not
 * compile. That is deliberate: the fallback glyph is honest for an ACP agent nobody here has heard of, and
 * dishonest for a first-class provider whose vendor has a mark everybody recognises.
 *
 * ADDING A PROVIDER is a row here, its brand path, and (daemon-side) one line in the provider registry.
 * Everything else derives — see agent-catalog.ts for the contract's derivations, and provider-specs.test.ts
 * for the guard that walks this table rather than a list. */

// What it COSTS to unlock a provider, and what the user connects to do it, the axis the picker groups on, since
// "can this row actually run" is the first thing a model list has to answer. `free` is not a courtesy tier: the
// Google channel serves its models on an ordinary Google sign-in, at no subscription, which is the single most
// useful thing this catalog can tell a user who has connected nothing yet.
//
// There is deliberately no `key` rung. Every provider here is unlocked by signing in to something the user
// already holds, so a per-call metered credential is not a shape this table can describe — a raw API key against
// somebody's own gateway is an `endpoint` capability (schemas/capabilities.ts), which is not a provider row and
// never appeared on this axis.
export type AccessKind = "free" | "subscription";

export interface ProviderAccess {
    readonly kind: AccessKind;
    // What the user connects, named the way its vendor names it, this is the noun every connect prompt uses.
    readonly requirement: string;
    // What connecting it lets them run, for the connect gate's one-line pitch.
    readonly runs: string;
}

// What a turn on this provider costs at the MARGIN, ordering the two kinds by the only question a helper
// spending the user's allowance on their behalf has to answer: free is free; a subscription is already paid but
// has a quota the user watches. Deliberately not folded into AccessKind's declaration order, a union's order is
// not a runtime fact, and this one is relied on.
export const ACCESS_COST: Record<AccessKind, number> = { free: 0, subscription: 1 };

/* HOW A CREDENTIAL FOR THIS PROVIDER IS OBTAINED AND HELD. Three mechanisms, and every surface that used to
 * branch on a provider's NAME (the web's readiness rules, the connect panel's shape, the daemon's credential
 * resolution) branches on this instead, so a fourth provider of an existing mechanism needs no new branch
 * anywhere.
 *
 *   "oauth"      , the daemon runs the sign-in itself and stores the tokens (one file per account under
 *                  .intentic/secrets/auth/<provider>/). Claude's PKCE paste-back and Cursor's poll-to-completion
 *                  are both this: what makes them one mechanism is who ends up holding the credential.
 *   "translator" , the bundled CLIProxyAPI holds a SUBSCRIPTION OAuth and re-serves it behind an Anthropic
 *                  endpoint, so the Claude Code loop can run a non-Claude model on it. `cliProxy` is that
 *                  provider's id in the proxy's own vocabulary, which is not always ours.
 *   "minted"     , the daemon runs a sign-in whose token is NOT an inference credential, so it goes on to mint
 *                  the vendor's own API key from it and stores that. The harness is then pointed straight at the
 *                  vendor's Anthropic Messages endpoint with the minted key — no translator hop, because there
 *                  is nothing to translate, the same road an `anthropic`-protocol endpoint capability drives.
 *
 * NOBODY PASTES A KEY, and the absence is the point rather than an omission. Both of these vendors sell a plan
 * and issue keys under it, and the first cut of these two providers therefore shipped as a password field — which
 * is a worse product than what the vendors' own CLIs do (their sign-in mints the key) and the only connect flow
 * in this app that asked the user to go and find a credential. The minted mechanism is that sign-in. A raw key
 * against somebody's own gateway is still supported and always was: it is an `endpoint` capability, not this.
 */
export type ProviderAuth =
    | { readonly kind: "oauth" }
    | { readonly kind: "translator"; readonly cliProxy: string }
    | { readonly kind: "minted"; readonly variants: readonly MintedVariant[] };

/* ONE IDENTITY PROVIDER A MINTED PROVIDER CAN BE SIGNED INTO, and the reason this is a list rather than three
 * fields on the auth row: Z.ai is one product sold through two entirely separate estates. An international plan
 * signs in at chat.z.ai and its key works against api.z.ai; a mainland GLM Coding Plan signs in at bigmodel.cn
 * and its key works against open.bigmodel.cn. Same models, same picker row, same store, and a credential minted
 * on one estate is refused by the other's endpoint.
 *
 * Which is why the bases live HERE and not on the provider: a key knows which variant minted it, and the turn
 * has to dial that variant's host. A provider-wide base URL would send a mainland plan's key to a host that has
 * never heard of it, and the failure would arrive as an authentication error the user cannot act on. */
export interface MintedVariant {
    // The stored account's record of where it came from, and what a `login/start` names. Never shown.
    readonly id: string;
    // What the connect row's estate control calls it, in the vendor's own words.
    readonly label: string;
    /* HOW THIS SIGN-IN ENDS, which decides the shape of the connect panel and nothing else.
     *
     *   "device"   , the daemon polls the vendor to completion and the account appears: nothing to paste back
     *                (Cursor's shape). Some of these also carry a one-time code to read off the card, which is
     *                a fact about the flow at RUNTIME, not about the provider, so it is not on this row.
     *   "redirect" , the vendor sends the browser to a loopback address only this container could bind, so the
     *                page dead-ends and the grant is in the address bar. The user brings that URL back
     *                (Google's shape, picture and all). */
    readonly flow: "device" | "redirect";
    // What ANTHROPIC_BASE_URL is set to for a turn on an account minted here. WITHOUT a version segment: the
    // harness appends `/v1/messages` itself (see the daemon's endpoint-config.ts for why the two ecosystems
    // disagree here).
    readonly anthropicBase: string;
    // Where this estate's model catalog is read from, an OpenAI-compatible root WITH its version segment,
    // because that is the surface these vendors publish `GET …/models` on.
    readonly catalogBase: string;
}

export interface ProviderSpec {
    // The wire id, and the reserved capability id: an installed `agent` capability may not take one of these.
    readonly id: string;
    // What the picker, the rail and the account tabs call it.
    readonly label: string;
    /* WHOSE ALLOWANCE A TURN ON THIS PROVIDER SPENDS, as the subject of a sentence, and not a duplicate of
     * `label` or of `access.requirement`. `label` names the RUNTIME the user picks ("Claude Code", "Kimi Code")
     * and `requirement` names the thing they CONNECT ("Claude subscription", "Google sign-in"); neither reads as
     * English in "… usage limit reached", and neither is what a spent quota belongs to.
     *
     * The routed providers are why this can't be inferred from the harness: a `gemini` turn drives Claude Opus
     * through Google's Antigravity channel on a plain Google sign-in, so the quota that refuses it is Google's
     * and Anthropic has no part in it. Saying "Claude usage limit reached" there sends the user to check the
     * wrong account, and to a reset that is days out on a pool they never touched. */
    readonly vendor: string;
    /* WHAT THE ACCOUNT ROWS ARE FILED UNDER: the tab in Sandbox ▸ Agent, the account picker's section, the
     * connect gate's chip. "Whose account is this", which is a fourth question and not the three above.
     *
     * It matches `vendor` for every provider but Grok, and that one exception is why it is a field rather than
     * an alias. A quota sentence has to say "xAI usage limit reached", because xAI is who metered it; the tab
     * a person clicks to connect the thing says "Grok", because that is what they came here to run and the
     * word "xAI" appears nowhere else in the chat. Folding the two would have made one of those wrong, and the
     * one that would have been wrong is whichever field the surface happened to reach for. */
    readonly accountLabel: string;
    // Where the sign-in actually happens, the destination, not the provider's product name: a user about to
    // leave the page wants to recognize the site they land on.
    readonly destination: string;
    readonly brand: ProviderBrand;
    readonly access: ProviderAccess;
    readonly auth: ProviderAuth;
    /* Whether a plan-limit reading for this provider is OBTAINABLE at all, one fact, on the wire, because both
     * halves need it and they need the same answer. The daemon reads it to decide what to even ask upstream for
     * (usage/translator-usage.ts); the browser reads it to say WHY an account shows no meter, which is the
     * difference between "this plan publishes nothing" and "we haven't measured yet", two states that look
     * identical as a blank row and mean opposite things.
     *
     * Four can be read, by two mechanisms that stop at the daemon's readers: Claude's rides its own turn (the
     * OAuth usage endpoint, agent.ts), ChatGPT's, Google's and Kimi's are pulled through the translator's
     * credential-scoped api-call. Kimi's endpoint is the platform's own `/coding/v1/usages`, which the Kimi Code
     * subscription's OAuth token reads directly, the bundled translator does not route it, but it does not have
     * to: the api-call substitutes that token server-side like it does for the other two.
     *
     * Grok is one absence, because xAI's usable billing data needs a subject id CLIProxyAPI keeps out of its
     * auth-file listing, and the fallback probe spends a token to answer. The minted providers are the other:
     * neither publishes a quota surface their own minted key can read. Adding one is a reader and this flag,
     * and nothing else. */
    readonly planLimits: boolean;
    /* THE TWO RUNTIMES THIS PROVIDER RUNS ON, one per value of the harness axis. Equal records mean the harness
     * is not a choice for this provider, and every surface reads that from here rather than keeping its own
     * list of the providers that offer the switch (see harnessChoosable, web-side).
     *
     * Three providers have a genuine fork (codex, grok, and Claude only trivially); three do not, for three
     * different and stated reasons — Kimi has no native runtime, Google refuses Claude Code's traffic outright,
     * and Cursor has no route but its own SDK. See the records themselves in agent-runtimes.ts. */
    readonly runtimes: { readonly native: AgentCapabilities; readonly claudeCode: AgentCapabilities };
}

/* `as const satisfies` rather than a plain annotation, and the two halves buy different things. `satisfies`
 * type-checks every row against the shape above, so a missing field or a misspelled access kind is a compile
 * error here rather than an `undefined` two packages away. `as const` keeps the ids and the auth kinds LITERAL,
 * which is what lets `NativeProvider` stay a union of six names instead of collapsing to `string`, and
 * `Record<NativeProvider, …>` therefore stay the compiler-enforced tables the daemon and the web depend on. */
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
        // Claude is always its own Claude Code loop: there is no second runtime to switch to, and the harness
        // axis is therefore not a choice here either.
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
        // The app says "grok" where CLIProxyAPI says "xai". Grok is also the one provider served BOTH ways: its
        // own xAI account runs its native loop, and the translator's subscription runs it under Claude Code.
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
        // Kimi has no native runtime: it only exists under the Claude Code loop, so both harnesses answer it.
        runtimes: { native: CLAUDE_CODE, claudeCode: CLAUDE_CODE },
    },
    {
        // Labelled for the ACCOUNT, not the model family: the `gemini` id names one channel. Google's
        // Antigravity, and that channel vends Claude and GPT-OSS models alongside Gemini's own (see
        // gemini-models.ts). A section headed "Gemini" holding Claude Opus would be a lie; "Google" is what the
        // whole list has in common.
        id: "gemini",
        label: "Google",
        vendor: "Google",
        accountLabel: "Google",
        destination: "Google",
        brand: "gemini",
        access: { kind: "free", requirement: "Google sign-in", runs: "Gemini, Claude and GPT-OSS under Claude Code" },
        // "antigravity" is Google's own agent product, and the name CLIProxyAPI files this credential under.
        auth: { kind: "translator", cliProxy: "antigravity" },
        planLimits: true,
        /* GEMINI IGNORES THE HARNESS, and it is the only routed provider that does. The Claude Code loop
         * announces itself in every request it sends and Google refuses on that announcement (see
         * OPENCODE_GEMINI), so "Gemini under Claude Code" was never a slower or poorer option, it was one that
         * could not complete a single turn, on any of the connected accounts, ever. Naming the same record on
         * both harnesses is what makes that structural rather than a rule each surface has to remember. */
        runtimes: { native: OPENCODE_GEMINI, claudeCode: OPENCODE_GEMINI },
    },
    {
        // Cursor's own agent runtime, driven through the SDK Anysphere publishes, on the user's Cursor
        // subscription. Like Google above, the label names the ACCOUNT rather than a model family: the channel
        // vends Anthropic, OpenAI and xAI models alongside Cursor's own Composer, and no model name covers that
        // list. The plan that gets billed is Cursor's, whichever vendor's model actually answered.
        id: "cursor",
        label: "Cursor",
        vendor: "Cursor",
        accountLabel: "Cursor",
        destination: "Cursor",
        brand: "cursor",
        // A `subscription` like the others, and the requirement names the PLAN rather than the account, because
        // a free Cursor account signs in perfectly and still cannot run a turn here: the SDK behind this
        // provider is gated to the paid tiers. Saying "Cursor account" would send someone to a sign-in that ends
        // in a refusal they had no way to predict.
        access: { kind: "subscription", requirement: "Cursor Pro subscription", runs: "Cursor Agent" },
        auth: { kind: "oauth" },
        planLimits: false,
        // Cursor ignores the harness for the mirror of Gemini's reason: there is no route to it but its own SDK.
        runtimes: { native: CURSOR, claudeCode: CURSOR },
    },
    /* THE TWO MINTED PROVIDERS, and the reason they cost no new runtime, no new adapter and no translator hop:
     * both publish an ANTHROPIC MESSAGES endpoint of their own. The Claude Code loop is pointed straight at it
     * with the key their sign-in minted, which is exactly the road an `anthropic`-protocol endpoint capability
     * already drives. So they are the Kimi shape — one record on both harnesses, no adapter, a catalog and a
     * readiness rung — and everything that makes them feel first-class (the brand, the badge, the section, the
     * account row) is these rows and nothing else. */
    {
        id: "meta",
        label: "Meta",
        vendor: "Meta",
        accountLabel: "Meta",
        destination: "Meta",
        brand: "meta",
        // A `subscription` like the rest, because that is what the sign-in connects: Muse Code's device login
        // mints a plan key, and the plan is what a turn spends. It shipped as `key` for one day, which put it in
        // the metered band and told automatic helpers every call here was real money — true of Meta's
        // pay-per-token Model API, and not true of the thing this row now connects.
        access: { kind: "subscription", requirement: "Muse Code subscription", runs: "Muse Spark under Claude Code" },
        auth: {
            kind: "minted",
            // One estate, so no choice to offer: `login/start` takes no variant for Meta and the connect row
            // shows no control. The id still exists because a stored account records which variant minted it.
            variants: [
                {
                    id: "meta",
                    label: "Meta",
                    // Meta's is the textbook device flow (RFC 8628): a user code to read off the card, and a
                    // poll that finishes without anything coming back here.
                    flow: "device",
                    // No version segment: the harness appends `/v1/messages` itself, and Meta serves the
                    // Anthropic surface there beside the OpenAI one the catalog is read from.
                    anthropicBase: "https://api.meta.ai",
                    catalogBase: "https://api.meta.ai/v1",
                },
            ],
        },
        // Nothing published that a minted key can read: no quota surface, so an account row shows no meter and
        // says so, rather than showing an empty one that reads as "nothing left".
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
        // A GLM Coding Plan: prepaid, with a quota the user watches, which is what `subscription` means to
        // ACCESS_COST and to the picker's ordering. The sign-in mints the plan's own key, so the requirement
        // names the plan rather than the credential — nobody has to go and find one.
        access: { kind: "subscription", requirement: "Z.ai GLM Coding Plan", runs: "GLM under Claude Code" },
        auth: {
            kind: "minted",
            /* TWO ESTATES, and a key minted on one is refused by the other, which is why they are two variants
             * rather than one base URL with a note. The catalog root is the CODING-PLAN one on both
             * (`/api/coding/paas/v4`), not the general `/api/paas/v4`: that is a different entitlement, and
             * pointing the catalog at it would list models the plan's own Anthropic endpoint then refuses,
             * which is the worst shape a picker row can have. */
            variants: [
                {
                    id: "zai",
                    // Cased as the vendor cases it, which is also how the row this control sits under is
                    // titled: a pill reading "Z.AI" under a row reading "Z.ai" is two spellings of one product
                    // on one screen.
                    label: "Z.ai international",
                    // zcode.z.ai mediates the callback itself, so the daemon polls it and nothing dead-ends in
                    // the user's browser.
                    flow: "device",
                    anthropicBase: "https://api.z.ai/api/anthropic",
                    catalogBase: "https://api.z.ai/api/coding/paas/v4",
                },
                {
                    id: "bigmodel",
                    label: "BigModel (中国大陆)",
                    // BigModel refuses that mediated callback and takes a loopback redirect instead, which no
                    // browser outside this container can reach: the page dead-ends carrying the grant, and the
                    // user brings the address back. Google's flow exactly, down to the picture.
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

/* The agent runtimes the daemon can serve, the vocabulary every surface that picks an agent shares (chat turns,
 * automations). The NATIVE providers have dedicated modules (and their ids are reserved); an `endpoint/<id>`
 * value names an installed `endpoint`-kind capability, and any other value is an installed `agent`-kind
 * capability served over ACP.
 *
 * DERIVED from the table above, so the wire vocabulary and the product facts cannot disagree: a spec row is a
 * provider the contract knows, and there is no way to add one without the other. The type stays a UNION of the
 * six names rather than widening to `string`, which is what keeps every `Record<NativeProvider, …>` in the
 * daemon and the web a table the compiler completes for you. */
export type NativeProvider = Spec["id"];
export const NATIVE_PROVIDERS: readonly NativeProvider[] = PROVIDER_SPECS.map((spec) => spec.id);

const BY_ID = new Map<string, ProviderSpec>(PROVIDER_SPECS.map((spec) => [spec.id, spec] as const));

// The row for a provider id, or nothing when the id names an ACP agent, an endpoint or a typo. The one lookup
// every derived table and every surface goes through.
export const providerSpec = (provider: string): ProviderSpec | undefined => BY_ID.get(provider);

/* The providers whose model runs UNDER the Claude Code harness through the bundled translator (CLIProxyAPI),
 * which holds their SUBSCRIPTION OAuth and re-serves it behind an Anthropic endpoint. `claude` is absent,
 * native Anthropic OAuth serves it directly, without the translator.
 *
 * Narrowed off the auth kind rather than listed again, so this and the `Record<KeyedProvider, …>` tables built
 * on it (the translator's accounts schema, its CLIProxyAPI id map) move together with the table. */
export type TranslatorProvider = Extract<Spec, { auth: { kind: "translator" } }>["id"];
export const TRANSLATOR_PROVIDERS: readonly TranslatorProvider[] = PROVIDER_SPECS.filter(
    (spec): spec is Extract<Spec, { auth: { kind: "translator" } }> => spec.auth.kind === "translator",
).map((spec) => spec.id);

// The providers whose sign-in mints the vendor's own API key, served straight off the vendor's own Anthropic
// Messages endpoint.
export type MintedProvider = Extract<Spec, { auth: { kind: "minted" } }>["id"];
export const MINTED_PROVIDERS: readonly MintedProvider[] = PROVIDER_SPECS.filter(
    (spec): spec is Extract<Spec, { auth: { kind: "minted" } }> => spec.auth.kind === "minted",
).map((spec) => spec.id);

// This provider's CLIProxyAPI id, where it has one. Not always ours: the app says "grok" where the proxy says
// "xai", and "gemini" where it says "antigravity".
export const cliProxyIdOf = (provider: string): string | undefined => {
    const auth = providerSpec(provider)?.auth;
    return auth?.kind === "translator" ? auth.cliProxy : undefined;
};

// Every estate a minted provider can be signed into, in the order the connect row offers them, or nothing when
// the provider is not one of them. The head is the default: what a `login/start` that names no variant gets.
export const mintedVariants = (provider: string): readonly MintedVariant[] | undefined => {
    const auth = providerSpec(provider)?.auth;
    return auth?.kind === "minted" ? auth.variants : undefined;
};

/* THE ESTATE ONE ACCOUNT BELONGS TO: its bases and its flow, whole, because a base URL read without its sibling
 * is how a catalog and a turn end up pointed at two different hosts.
 *
 * An ABSENT id takes the default (the head of the list), which is what a connect row that offers no choice
 * sends and what a store written before a second variant existed reads back as. An id that names no variant is
 * `undefined` and NOT the default: silently falling back would dial a mainland key against api.z.ai and report
 * the refusal as an authentication problem, when what happened is that we lost track of where the key came
 * from. */
export const mintedVariant = (provider: string, variant?: string): MintedVariant | undefined => {
    const variants = mintedVariants(provider);
    if (variants === undefined) {
        return undefined;
    }
    return variant === undefined || variant === "" ? variants[0] : variants.find((entry) => entry.id === variant);
};
