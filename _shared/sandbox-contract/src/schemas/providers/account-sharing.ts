import { z } from "zod";
import { EndpointConfigSchema } from "../capabilities.js";
import { OauthAccountSchema } from "./provider-oauth.js";

// SHARING MODEL ACCOUNTS between one owner's sandboxes, over an accounts link (schemas/links.ts, `terms.accounts`).
// Each account goes the one way that is safe for its credential:
// - copy: a static key (Cursor, Devin, a minted Z.ai or Muse key, a model endpoint's API key) is read by the target's
//   daemon from the source's over the link and stored as the target's own; nothing ties the two afterwards.
// - lend: a sign-in whose refresh token rotates (a Claude subscription) stays with the source; the target asks it for
//   an access token each turn. The refresh token never leaves the source, so the two sandboxes never race to renew one
//   login. A subscription the translator holds (Codex, Grok, Kimi, Gemini) is listed as `no` for now: lending it would
//   relay every request through the source's translator, which the target's runtimes do not do yet.
// - no: what cannot travel either way, with the reason a person reads.
// Values never ride the editor's wire: the browser sees these rows, and the target's daemon fetches a copy itself.

export const ShareModeSchema = z.enum(["copy", "lend", "no"]);
export type ShareMode = z.infer<typeof ShareModeSchema>;

// One account an accounts link names: a provider (an AgentProvider id, `endpoint/<id>` included) and, for a provider
// holding several of its own, which one. A translator provider is shared whole, since its translator picks among its
// own subscriptions and takes no account, so `account` is absent there.
export const SharedAccountRefSchema = z.object({
    provider: z.string().min(1).max(120),
    account: z.string().min(1).max(200).optional(),
});
export type SharedAccountRef = z.infer<typeof SharedAccountRefSchema>;

export const sameSharedRef = (a: SharedAccountRef, b: SharedAccountRef): boolean => a.provider === b.provider && a.account === b.account;

// GET /sharing/accounts on the source: everything it holds, and how each would reach another sandbox.
export const ShareableAccountSchema = SharedAccountRefSchema.extend({
    label: z.string().describe("What the source calls it."),
    email: z.string().optional(),
    mode: ShareModeSchema,
    reason: z.string().optional().describe("Why it cannot be shared, when `mode` is no."),
});
export type ShareableAccount = z.infer<typeof ShareableAccountSchema>;
export const ShareableAccountsSchema = z.object({
    sandbox: z.string().describe("What the source calls itself."),
    accounts: z.array(ShareableAccountSchema),
});
export type ShareableAccounts = z.infer<typeof ShareableAccountsSchema>;

// A copy of one static account, the fields every static store keeps. Only the target's daemon ever reads one.
export const StaticAccountCopySchema = z.object({
    label: z.string().optional(),
    email: z.string().optional(),
    variant: z.string().optional(),
    plan: z.string().optional(),
    apiKey: z.string().min(1),
    apiKeyExpiresAtMs: z.number().optional(),
    backendUrl: z.string().optional(),
});
export type StaticAccountCopy = z.infer<typeof StaticAccountCopySchema>;

export const AccountCopySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("account"), account: StaticAccountCopySchema }),
    z.object({ kind: z.literal("endpoint"), id: z.string().min(1), config: EndpointConfigSchema }),
]);
export type AccountCopy = z.infer<typeof AccountCopySchema>;

/* THE LINK DOORS for accounts, called by the target's daemon with the link token. */

// GET /link/accounts: what this link may use, as rows without credentials, each with the source's own usage reading,
// so the target shows the source's figures instead of measuring the same plan twice.
export const LinkAccountSchema = OauthAccountSchema.extend({
    provider: z.string(),
    mode: z.enum(["copy", "lend"]),
});
export type LinkAccount = z.infer<typeof LinkAccountSchema>;
export const LinkAccountsSchema = z.object({ accounts: z.array(LinkAccountSchema) });
export type LinkAccounts = z.infer<typeof LinkAccountsSchema>;

// POST /link/accounts/copy: one static account's value, for an account the link names in copy mode only.
export const LinkAccountCopySchema = z.object({ copy: AccountCopySchema });
export type LinkAccountCopy = z.infer<typeof LinkAccountCopySchema>;

/* THE TARGET'S OWN ROUTES, called by the owner's editor. */

// POST /sharing/borrow: bring the named accounts in over the accounts link saved as `card`.
export const AccountsBorrowSchema = z.object({
    card: z.string().min(1).describe("The link card the editor saved for the source."),
    items: z.array(SharedAccountRefSchema).min(1).max(64),
});
export type AccountsBorrow = z.infer<typeof AccountsBorrowSchema>;

export const BorrowOutcomeSchema = SharedAccountRefSchema.extend({
    outcome: z.enum(["copied", "borrowed", "failed"]),
    id: z.string().optional().describe("The account's id here, for a copy or a borrow."),
    message: z.string().optional().describe("Why it failed, in words a person can act on."),
});
export type BorrowOutcome = z.infer<typeof BorrowOutcomeSchema>;
export const AccountsBorrowedSchema = z.object({ results: z.array(BorrowOutcomeSchema) });
export type AccountsBorrowed = z.infer<typeof AccountsBorrowedSchema>;

// Where a borrowed account comes from, as a row here says it.
export const BorrowedFromSchema = z.object({
    name: z.string().describe("What the source calls itself."),
    sandboxId: z.string().optional(),
});
export type BorrowedFrom = z.infer<typeof BorrowedFromSchema>;

// One account this sandbox borrows: no credential in it, only where to ask. Access tokens are held in memory.
export const BorrowedAccountSchema = z.object({
    id: z.string().describe("Its id here: what a turn names, and what Stop borrowing takes."),
    card: z.string().describe("The link card it is borrowed through."),
    provider: z.string(),
    remote: z.string().optional().describe("Its id on the source; absent for a translator provider, borrowed whole."),
    label: z.string(),
    email: z.string().optional(),
    organization: z.string().optional(),
    from: BorrowedFromSchema,
    borrowedAt: z.number(),
});
export type BorrowedAccount = z.infer<typeof BorrowedAccountSchema>;
export const BorrowedAccountsSchema = z.object({ accounts: z.array(BorrowedAccountSchema) });
export type BorrowedAccounts = z.infer<typeof BorrowedAccountsSchema>;

export const BorrowedAccountIdSchema = z.object({ id: z.string().min(1) });

// The prefix every borrowed account's id here carries, so no store mistakes one for an account of its own.
export const BORROWED_ID_PREFIX = "lent-";
export const isBorrowedId = (id: string): boolean => id.startsWith(BORROWED_ID_PREFIX);
