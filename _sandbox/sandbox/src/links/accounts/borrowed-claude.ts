import { SingleFlight } from "@intentic/base/async";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { type BorrowedAccount, isBorrowedId, type LinkAccount } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Logger } from "pino";
import type { ClaudeLender } from "../../agent/providers/claude/claude-lender.js";
import { type LinkTarget, linkAccounts, linkCredential, linkCredentialRefresh } from "../../sandboxes/link-client.js";
import { opt } from "../../opt.js";
import type { BorrowedStore } from "./borrowed-store.js";

// THE BORROWING SIDE OF A LENT CLAUDE SIGN-IN (agent/providers/claude/claude-lender.ts). Each turn's token is asked of
// the lending sandbox over the accounts link and held in memory only, never on disk, so nothing this sandbox writes or
// bundles carries a credential. The rows come from the lender too: its usage reading, and whether the sign-in still
// works there, so this sandbox never measures the same plan a second time.

// How long a lent token is reused before asking again: the lender hands out one with at least half an hour left
// (claude-credentials.ts REFRESH_AHEAD_MS), and a provider's refusal mid-turn asks for a new one anyway.
const TOKEN_REUSE_MS = 10 * 60_000;
// How long a lender's description of its accounts is reused: listing runs before every turn's pick.
const ROWS_REUSE_MS = 60_000;
// A list must not wait on a lender that is not answering: past this the row says so.
const ROWS_WAIT_MS = 3_000;

export interface BorrowedClaudeDeps {
    readonly store: BorrowedStore;
    readonly cards: () => Promise<readonly Capability[]>;
    readonly logger: Logger;
    readonly now?: () => number;
}

type Described = { readonly ok: true; readonly accounts: readonly LinkAccount[] } | { readonly ok: false; readonly message: string };

const cardOf = (cards: readonly Capability[], id: string): LinkTarget | undefined => {
    const card = cards.find((candidate) => candidate.id === id);
    return card?.kind === "link" ? { id: card.id, config: card.config } : undefined;
};

const unanswered = (entry: BorrowedAccount, message: string): string =>
    `${entry.from.name} did not lend this account a token (${message}). Check that it is running, or bring the account in again.`;

const rowOf = (entry: BorrowedAccount, described: Described | undefined): OauthAccount => {
    const base: OauthAccount = {
        id: entry.id,
        label: entry.label,
        ...opt("email", entry.email),
        ...opt("organization", entry.organization),
        connectedAt: entry.borrowedAt,
        borrowedFrom: entry.from,
    };
    if (described === undefined || !described.ok) {
        return { ...base, detail: `${entry.from.name} is not answering, so this borrowed account cannot run turns until it does.` };
    }
    const remote = described.accounts.find((account) => account.provider === "claude" && account.id === entry.remote);
    if (remote === undefined) {
        return { ...base, needsReauth: true, detail: `${entry.from.name} no longer lends this account. Bring it in again from there.` };
    }
    const row: OauthAccount = {
        ...base,
        label: remote.label,
        ...opt("email", remote.email),
        ...opt("usage", remote.usage),
        ...opt("seatRefusal", remote.seatRefusal),
    };
    return remote.needsReauth === true ? { ...row, needsReauth: true, detail: `Sign it in again on ${entry.from.name}, which lends it.` } : row;
};

export const createBorrowedClaude = (deps: BorrowedClaudeDeps): ClaudeLender => {
    const now = deps.now ?? Date.now;
    const tokens = new Map<string, { readonly token: string; readonly at: number }>();
    const described = new Map<string, { readonly answer: Described; readonly at: number }>();
    const asking = new SingleFlight<string, string | undefined>();

    const entryAndCard = async (id: string): Promise<{ readonly entry: BorrowedAccount; readonly card: LinkTarget }> => {
        const entry = await deps.store.get(id);
        if (entry === undefined || entry.remote === undefined) {
            throw new Error("This borrowed account is no longer filed here. Bring it in again from the sandbox that lends it.");
        }
        const card = cardOf(await deps.cards(), entry.card);
        if (card === undefined) {
            throw new Error(`The link to ${entry.from.name} this account was borrowed through is gone. Bring the account in again.`);
        }
        return { entry, card };
    };

    const describe = async (card: LinkTarget): Promise<Described> => {
        const kept = described.get(card.id);
        if (kept !== undefined && now() - kept.at < ROWS_REUSE_MS) {
            return kept.answer;
        }
        const answer = await linkAccounts(card, AbortSignal.timeout(ROWS_WAIT_MS));
        const value: Described = answer.ok ? { ok: true, accounts: answer.value.accounts } : { ok: false, message: answer.message };
        described.set(card.id, { answer: value, at: now() });
        return value;
    };

    const lease = async (id: string): Promise<string | undefined> => {
        const { entry, card } = await entryAndCard(id);
        const answer = await linkCredential(card, { agent: "claude", account: entry.remote });
        if (!answer.ok) {
            throw new Error(unanswered(entry, answer.message));
        }
        if (!answer.value.ok) {
            throw new Error(`${entry.from.name} could not lend this account a token: ${answer.value.message}`);
        }
        if (answer.value.kind !== "oauth") {
            throw new Error(`${entry.from.name} answered with a route, not a Claude token: it may run an older build.`);
        }
        tokens.set(id, { token: answer.value.accessToken, at: now() });
        return answer.value.accessToken;
    };

    return {
        owns: isBorrowedId,
        rows: async () => {
            const [entries, cards] = await Promise.all([deps.store.list(), deps.cards()]);
            const claude = entries.filter((entry) => entry.provider === "claude");
            const byCard = new Map<string, Described | undefined>();
            await Promise.all(
                [...new Set(claude.map((entry) => entry.card))].map(async (cardId) => {
                    const card = cardOf(cards, cardId);
                    byCard.set(cardId, card === undefined ? undefined : await describe(card));
                }),
            );
            return claude.map((entry) => rowOf(entry, byCard.get(entry.card)));
        },
        token: async (id) => {
            const kept = tokens.get(id);
            if (kept !== undefined && now() - kept.at < TOKEN_REUSE_MS) {
                return kept.token;
            }
            return await asking.run(id, () => lease(id));
        },
        replace: async (id, rejected) => {
            const kept = tokens.get(id);
            // Another turn already had the refused token replaced: that replacement is the answer.
            if (kept !== undefined && kept.token !== rejected) {
                return kept.token;
            }
            tokens.delete(id);
            const { entry, card } = await entryAndCard(id);
            if (entry.remote === undefined) {
                return undefined;
            }
            const answer = await linkCredentialRefresh(card, { account: entry.remote, rejected });
            if (!answer.ok || answer.value.accessToken === undefined) {
                deps.logger.warn({ account: id, from: entry.from.name }, "borrowed claude: the lender could not renew the refused token");
                return undefined;
            }
            tokens.set(id, { token: answer.value.accessToken, at: now() });
            return answer.value.accessToken;
        },
        forget: async (id) => {
            tokens.delete(id);
            await deps.store.remove(id);
        },
    };
};
