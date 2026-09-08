import { z } from "zod";
import { AccountUsageSchema } from "./plan-limits.js";
import { KeyedProviderSchema } from "./provider-subscriptions.js";
// Claude uses PKCE paste-back (start → exchange); Codex uses OpenAI's device-code flow (start → poll). A sandbox can
// hold several accounts per provider; `id` is the store key, `label` the display name. Tokens never ride this shape —
// connection is existence in the list.

export const OauthAccountSchema = z.object({
    id: z.string().describe("The account's id, which is what a turn names to spend on it and what disconnecting takes."),
    label: z.string().describe("What it is called here, which somebody can change."),
    email: z
        .string()
        .optional()
        .describe(
            "Who it signs in as, in the provider's own words. Kept beside the label rather than folded into it, so a renamed account can still say whose it is. Absent when the provider says nothing, which is exactly when renaming is the only answer.",
        ),
    organization: z.string().optional().describe("Which organisation it belongs to, where the provider says."),
    scope: z.string().optional().describe("What the credential is permitted to do, in the provider's terms."),
    connectedAt: z.number().describe("When it was connected, in milliseconds."),
    needsReauth: z
        .boolean()
        .optional()
        .describe("Its stored credential can no longer be renewed and somebody has to sign in again. Absent means healthy, or not checked yet."),
    detail: z.string().optional().describe("Why, in words a person can act on."),
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
// Read off the query string as `?force=1`.
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
// Only for accounts whose credential the sandbox itself owns.
export const AccountRenameSchema = z.object({
    id: z.string().min(1).describe("Which account."),
    label: z.string().max(80).describe("The new name. Blank restores the one derived from the sign-in, rather than leaving a nameless row."),
});
// One shape for every sign-in, whatever the vendor's mechanism; nothing redeemable rides on it, only the daemon ever
// holds a secret. `flow` says how the attempt ends, which no other field can tell you:
// device: finishes upstream; watch the account list.
// redirect: needs the landing address brought back.
// paste: needs the code the page showed.
export const LoginFlowSchema = z.enum(["device", "redirect", "paste"]);
export type LoginFlow = z.infer<typeof LoginFlowSchema>;
export const LoginStartSchema = z.object({
    url: z.string().describe("The page to open and sign in on."),
    code: z.string().describe("The one-time code the page will ask for, where the vendor issues one. Blank when the page is already addressed to this attempt."),
    state: z
        .string()
        .describe("For a redirect sign-in, the marker in the address the browser lands on, so a pasted URL can be recognised as this attempt's. Blank otherwise."),
    flow: LoginFlowSchema.describe(
        "How this attempt ends. A device sign-in finishes by itself and you watch the account list; a redirect needs the address it landed on handed back; a paste needs the code the page showed.",
    ),
    variant: z.string().describe("Which of the provider's estates this attempt signs in to. Blank for a provider with one."),
    handshake: z
        .string()
        .describe("This attempt's id, for finishing or abandoning it. Not a credential and not redeemable: the proof that completes the sign-in never leaves the sandbox."),
    expiresAt: z.number().describe("When this attempt stops being answerable, in milliseconds, so a card can stop waiting instead of spinning."),
});
export type LoginStart = z.infer<typeof LoginStartSchema>;
// e.g. Z.ai's international vs. mainland plans.
export const LoginRequestSchema = z.object({
    variant: z.string().min(1).optional().describe("Which estate to sign in to. Absent takes the provider's default."),
});
// Only the two flows needing something back (paste's code, redirect's address) supply one; no state field, unlike the
// translator's — this handshake is held right here, so the caller's own state would be checking a claim against itself.
export const LoginCompleteSchema = z.object({
    handshake: z.string().min(1).describe("Which attempt this belongs to."),
    code: z.string().optional().describe("The code the sign-in page showed, for a paste sign-in."),
    redirectUrl: z.string().optional().describe("The address the browser was sent to, whole, for a redirect sign-in. The grant is inside it."),
    label: z.string().optional().describe("What to call the account. Blank derives one from the sign-in."),
});
// Absent when the daemon still has minting to do; the row lands in the account list minutes later.
export const LoginCompletedSchema = z.object({
    account: OauthAccountSchema.optional().describe("The account it connected, where the sign-in ends here. Absent means keep watching the account list."),
});
// Tidiness, not a security boundary: an unanswered attempt also times out on its own (`expiresAt`).
export const LoginCancelSchema = z.object({ handshake: z.string().min(1).describe("Which attempt to stop waiting on.") });
// codex/grok/kimi/gemini via CLIProxyAPI; `flow` is explicit even when a provider's URL already embeds an optional
// code.
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
// Grant rides in the URL as `?code=&state=`.
export const TranslatorCompleteSchema = z.object({
    provider: KeyedProviderSchema.describe("Which provider."),
    redirectUrl: z.string().min(1).describe("The address the browser was sent to, whole. The grant is inside it."),
    state: z.string().min(1).describe("The handshake this belongs to. A mismatch is refused."),
});
// Resolved daemon-side (live discovery, a persisted fallback, a seed floor), never empty. Every field is
// provider-reported, nothing curated here, so an id-only provider renders label-only rather than a hand-written table.
// Order is meaningful: the provider's own preference order, never re-ranked.
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
    // The served window, not the training length — memory can clamp it lower. Turns are refused against this. Absent
    // means unknown, never unlimited.
    contextWindow: z.number().optional().describe("How many tokens this model will accept in one request, where the server publishes it."),
});
export type Model = z.infer<typeof ModelSchema>;
export const ModelsSchema = z.object({
    models: z.array(ModelSchema).describe("What this provider serves, in its own preference order, which is not rearranged here. Never empty."),
    default: z.string().describe("Which one a fresh conversation starts on. Always present."),
});
