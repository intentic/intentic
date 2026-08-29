import { z } from "zod";
import { AccountUsageSchema } from "./plan-limits.js";
import { KeyedProviderSchema } from "./provider-subscriptions.js";
// Claude uses the PKCE authorize-URL + paste-back handshake (start → exchange). Codex uses OpenAI's device-code
// flow (start → poll): the browser signs in at verificationUri and enters userCode; the daemon polls until done.
// A sandbox can hold several accounts per provider side by side: `id` is the daemon-minted store key, `label`
// the user's display name (auto-filled from the sign-in identity where the token carries one). Tokens never
// ride this shape, connection status is existence in the list.

export const OauthAccountSchema = z.object({
    id: z.string().describe("The account's id, which is what a turn names to spend on it and what disconnecting takes."),
    label: z.string().describe("What it is called here, which somebody can change."),
    // WHO this account signs in as, in the provider's own words. Anthropic returns the email and the
    // organization alongside the tokens, so a connection can name itself instead of arriving as a second row
    // called "Claude". Kept BESIDE `label` rather than folded into it: the label is the user's to rename, and a
    // renamed account still has to be able to say whose it is. Absent when the provider tells us nothing (a
    // pasted API key carries no identity), which is exactly when renaming is the only answer, so every
    // sandbox-owned account can be renamed.
    email: z
        .string()
        .optional()
        .describe(
            "Who it signs in as, in the provider's own words. Kept beside the label rather than folded into it, so a renamed account can still say whose it is. Absent when the provider says nothing, which is exactly when renaming is the only answer.",
        ),
    organization: z.string().optional().describe("Which organisation it belongs to, where the provider says."),
    scope: z.string().optional().describe("What the credential is permitted to do, in the provider's terms."),
    connectedAt: z.number().describe("When it was connected, in milliseconds."),
    // Set only when the account's stored credential can no longer be refreshed (revoked/expired refresh token)
    //, the user must reconnect. Absent ⇒ healthy or not-yet-probed; `detail` carries the reason for the UI.
    // Provider-agnostic; only Codex probes it today (Claude refreshes on-demand, Grok's tokens are OpenCode's).
    needsReauth: z
        .boolean()
        .optional()
        .describe("Its stored credential can no longer be renewed and somebody has to sign in again. Absent means healthy, or not checked yet."),
    detail: z.string().optional().describe("Why, in words a person can act on."),
    // The account's last known subscription-usage snapshot, so the picker can show what's left on each account
    // before the user commits a turn to one. Absent until a reading exists for it, an unmeasured account reads
    // as unknown, never 0%. Claude is the provider that fills it here, because its stream reports the windows;
    // the routed subscriptions carry the identical field on TranslatorAccount, filled by a pulled reading.
    usage: AccountUsageSchema.optional().describe(
        "How full its plan limits were when last measured, so a picker can show what is left before committing work to it. Absent until a reading exists, which reads as unknown rather than as nothing left.",
    ),
});
export type OauthAccount = z.infer<typeof OauthAccountSchema>;
export const OauthAccountListSchema = z.object({
    accounts: z
        .array(OauthAccountSchema)
        .describe("The connected accounts. Tokens never travel in this shape: being in this list is what connected means."),
});
export type OauthAccountList = z.infer<typeof OauthAccountListSchema>;
/* RE-MEASURE THIS PROVIDER'S PLAN LIMITS BEFORE ANSWERING, rather than serving whatever reading is current
 * enough by the daemon's own bound. Every ordinary read of the list wants that bound, it is what keeps a page
 * load off the upstream quota endpoint, but a person who has just changed something about the account
 * (a seat downgraded, a plan swapped, another device's spend) is asking precisely whether the reading they can
 * see is still true, and an answer from the last minute cannot tell them. Read off the query string, so the
 * caller says it as `?force=1`. */
export const AccountListQuerySchema = z.object({
    force: z
        .stringbool()
        .default(false)
        .describe(
            "Measure the plan limits again before answering, rather than serving a recent reading. Slower, and the right thing when somebody has just changed a plan and is asking whether what they can see is still true.",
        ),
});
// Address one account of a provider (disconnect, and the turn's `account`).
export const AccountIdSchema = z.object({ id: z.string().min(1).describe("Which account.") });
// Rename one account of a provider whose credential the sandbox owns (Claude, Kimi). Blank ⇒ the daemon falls
// back to the derived name, so clearing a label restores the sign-in identity rather than leaving a nameless
// row. Grok is absent for the same reason it holds one account: OpenCode owns that credential, not this store.
export const AccountRenameSchema = z.object({
    id: z.string().min(1).describe("Which account."),
    label: z.string().max(80).describe("The new name. Blank restores the one derived from the sign-in, rather than leaving a nameless row."),
});
// The completing calls carry the user-chosen label (blank ⇒ the daemon derives one from the sign-in identity
// or a provider default).
export const OauthExchangeSchema = z.object({
    code: z.string().min(1).describe("The code the sign-in handed back."),
    verifier: z.string().min(1).describe("The proof from the start of the handshake, which is what stops somebody else's code being redeemed here."),
    state: z.string().min(1).describe("The handshake this belongs to. A mismatch is refused."),
    label: z.string().optional().describe("What to call the account. Blank derives one from the sign-in."),
});
export const AuthorizeChallengeSchema = z.object({
    authorizeUrl: z.string().describe("Where to send somebody to sign in."),
    verifier: z.string().describe("Keep this and send it back when finishing. It is what proves the code that comes back belongs to this handshake."),
    state: z.string().describe("The handshake's own id, sent back with it."),
});
/* CURSOR'S SIGN-IN START. A third login shape, and the reason it is not one of the two above is where the
 * SECRET lives during the handshake.
 *
 * Claude's is paste-back: the browser receives a code and the caller hands it plus its verifier to `exchange`,
 * so the handshake's proof has to travel on the wire and AuthorizeChallengeSchema carries it. Cursor's PKCE
 * verifier must never leave the process that generated it, anyone holding it can redeem the login and mint a
 * durable key, so the daemon starts the whole flow, keeps the verifier in memory, polls Cursor itself, and
 * writes the account when it lands. Nothing redeemable is on this shape at all.
 *
 * Which makes it behave like a DEVICE flow from the caller's side (open the page, then watch the account list),
 * except that there is no one-time code to display: the login page is addressed to this handshake already. So
 * DeviceStartSchema's `code` would be a permanently blank field on every card, and TranslatorStartSchema's
 * `state` a value nothing sends back. `handshake` is neither, it is a cancellation handle. */
export const CursorLoginStartSchema = z.object({
    url: z.string().describe("The page to open and sign in on. It is already addressed to this attempt, so there is no code to type."),
    handshake: z
        .string()
        .describe(
            "This attempt's id, for abandoning it. Not a credential and not redeemable: the proof that finishes the sign-in never leaves the sandbox.",
        ),
    expiresAt: z.number().describe("When this attempt stops being answerable, in milliseconds, so a card can stop waiting instead of spinning."),
});
export type CursorLoginStart = z.infer<typeof CursorLoginStartSchema>;
// Abandon a sign-in nobody completed, so the daemon stops polling Cursor for it. Ordinary tidiness rather than
// a security boundary: an unanswered attempt also times out on its own (see `expiresAt`).
export const CursorLoginCancelSchema = z.object({ handshake: z.string().min(1).describe("Which attempt to stop waiting on.") });
// xAI Grok (via OpenCode) uses subscription OAuth via the headless device-code method. `start` returns the
// `url` the user opens (xAI's verification_uri_complete, which pre-fills the code) and `code`, the same
// one-time code, surfaced so the card matches x.ai exactly. There is no paste-back: OpenCode polls to
// completion and the UI polls `/grok/accounts`.
// ponytail: OpenCode holds one xAI auth per data dir, so Grok stays single-account, the list is 0 or 1. Per
// account would need an OpenCode server per data dir; add when there's demand.
// A device-code login start: the verification URL + the one-time code the user enters there. The native Grok
// flow (via OpenCode), see TranslatorStartSchema for the routed-provider connect, which adds `state`.
export const DeviceStartSchema = z.object({
    url: z.string().describe("The page to open, which already has the code in it."),
    code: z
        .string()
        .describe(
            "The one-time code, shown as well so the page and the card say the same thing. Nothing is pasted back: the sandbox waits for the sign-in to complete on its own.",
        ),
});
// A routed-provider subscription login start (codex/grok/kimi/gemini via CLIProxyAPI). Device flows poll to
// completion after the user approves upstream; redirect flows need the browser's landing URL pasted back. The
// explicit flow discriminator matters even when a provider's verification URL already embeds its optional code.
export const TranslatorStartSchema = z.object({
    url: z.string().describe("The page to open."),
    code: z.string().describe("The one-time code, where the provider uses one."),
    state: z.string().describe("The handshake's id, which the finishing call sends back."),
    flow: z
        .enum(["device", "redirect"])
        .describe(
            "Which shape this is. A device sign-in finishes by itself and you poll the account list; a redirect needs the address it landed on handed back. Said outright rather than guessed at from whether a code happens to exist.",
        ),
});
// The paste-back half of a redirect login: the URL the provider sent the browser to, carrying the grant as
// ?code=&state=. `state` ties it to the handshake that issued it, the translator rejects a mismatch.
export const TranslatorCompleteSchema = z.object({
    provider: KeyedProviderSchema.describe("Which provider."),
    redirectUrl: z.string().min(1).describe("The address the browser was sent to, whole. The grant is inside it."),
    state: z.string().min(1).describe("The handshake this belongs to. A mismatch is refused."),
});
// A provider's model catalog, resolved daemon-side from live discovery with a persisted last-known-good list and
// a seed floor (Grok via opencode.ts xaiModels, Codex via codex-models.ts, Claude via the Agent SDK's
// supportedModels), never empty, so the picker is never blank. `label` is the provider's display name; `default`
// is the model a fresh chat on that provider seeds (always present). Served by the one catalog route every
// provider shares. `efforts` is the reasoning-effort tiers the model accepts (Claude reports them per model);
// empty ⇒ the client's default tiers.
//
// EVERY field here is provider-reported, nothing about a model is curated in this repo, so a new release or a
// renamed family flows to the UI with no code change. Providers differ in how much they publish: the Claude
// Agent SDK reports a display name, a capability description, effort tiers, and capability flags, while the
// Some OpenAI-compatible /v1/models endpoints report ids only, those rows render label-only, and that absence
// is the honest answer rather than something to paper over with a hand-written table.
//
// ORDER IS MEANINGFUL: `models` arrives in the provider's own preference order, which is what the picker sorts
// by, and `default` is the provider's own default. Neither is re-ranked locally.
export const ModelBadgeSchema = z.enum(["reasoning", "fast"]);
export type ModelBadge = z.infer<typeof ModelBadgeSchema>;
export const ModelSchema = z.object({
    id: z.string().describe("What to name when asking for this model."),
    label: z.string().describe("What to call it on screen."),
    efforts: z.array(z.string()).optional().describe("The thinking levels it accepts, where the provider says. Empty means use your own defaults."),
    description: z
        .string()
        .optional()
        .describe(
            "What it is good for, in the provider's own words. Absent where the provider publishes only ids, which is the honest answer rather than something to paper over with a hand-written table.",
        ),
    badges: z.array(ModelBadgeSchema).optional().describe("What it is known for, where the provider says so."),
    /* HOW MUCH THE SERVER WILL ACCEPT IN ONE REQUEST, where the server says so, and the one field here that a
     * turn is refused against rather than merely rendered (agent/context-budget.ts).
     *
     * The SERVED window, never the weights' training length. An inference server takes its context size from a
     * flag and then clamps it to the memory it actually has, so a 3B model whose GGUF advertises 131k can be
     * serving 16k, and it is the 16k that refuses the request. Read from llama.cpp's /props and vLLM's
     * `max_model_len`; absent for every provider that publishes no such number, which is most of them, and
     * absent means unknown rather than unlimited: nothing gates on a window it was never told. */
    contextWindow: z.number().optional().describe("How many tokens this model will accept in one request, where the server publishes it."),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelsSchema = z.object({
    models: z.array(ModelSchema).describe("What this provider serves, in its own preference order, which is not rearranged here. Never empty."),
    default: z.string().describe("Which one a fresh conversation starts on. Always present."),
});
