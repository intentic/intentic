import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type {
    AccountsBorrow,
    AccountsBorrowed,
    BorrowOutcome,
    LinkAccount,
    SharedAccountRef,
} from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { Logger } from "pino";
import { type LinkTarget, linkAccountCopy, linkAccounts } from "../../sandboxes/link-client.js";
import { opt } from "../../opt.js";
import { type CopyInDeps, copyIn } from "./account-copies.js";
import type { BorrowedStore } from "./borrowed-store.js";

// BRINGING ACCOUNTS IN over an accounts link (POST /sharing/borrow): each one the way the lending sandbox says it may go.
// A static key is copied into this sandbox's own store; a sign-in the lender renews is filed as borrowed, and its tokens
// are asked for turn by turn (borrowed-claude.ts). Each account answers on its own, so one the lender refuses leaves
// the rest in.

export interface BorrowingDeps {
    readonly store: BorrowedStore;
    readonly cards: () => Promise<readonly Capability[]>;
    readonly copies: CopyInDeps;
    // What a capability write runs after it, once after every copy (the environment, the endpoint routes).
    readonly settle: () => Promise<void>;
    // The model catalogs a newly borrowed sign-in changes.
    readonly borrowed: () => void;
    readonly logger: Logger;
}

const failed = (ref: SharedAccountRef, message: string): BorrowOutcome => ({ ...ref, outcome: "failed", message });

// Whether a row the lender offers is the account `ref` names: a provider shared whole (a translator's, an endpoint) has
// one row, named by the provider alone.
const offers = (row: LinkAccount, ref: SharedAccountRef): boolean => row.provider === ref.provider && (ref.account === undefined || row.id === ref.account);

const cardOf = (cards: readonly Capability[], id: string): (LinkTarget & { readonly name: string }) | undefined => {
    const card = cards.find((candidate) => candidate.id === id);
    return card?.kind === "link" ? { id: card.id, config: card.config, name: card.config.name ?? card.id } : undefined;
};

const bringOne = async (deps: BorrowingDeps, card: LinkTarget & { readonly name: string }, offered: readonly LinkAccount[], ref: SharedAccountRef): Promise<BorrowOutcome> => {
    const row = offered.find((account) => offers(account, ref));
    if (row === undefined) {
        return failed(ref, `${card.name} does not lend that account over this link.`);
    }
    if (row.mode === "copy") {
        const copied = await linkAccountCopy(card, ref);
        if (!copied.ok) {
            return failed(ref, `${card.name} did not hand over a copy: ${copied.message}`);
        }
        try {
            return { ...ref, outcome: "copied", id: await copyIn(deps.copies, ref.provider, copied.value.copy) };
        } catch (error) {
            return failed(ref, error instanceof Error ? error.message : "the copy could not be stored here");
        }
    }
    const filed = await deps.store.add({
        card: card.id,
        provider: ref.provider,
        ...opt("remote", ref.account),
        label: row.label,
        ...opt("email", row.email),
        ...opt("organization", row.organization),
        from: { name: card.name, ...opt("sandboxId", card.config.sandboxId) },
    });
    return { ...ref, outcome: "borrowed", id: filed.id };
};

/** POST /sharing/borrow */
export const borrowAccounts = async (deps: BorrowingDeps, input: AccountsBorrow): Promise<AccountsBorrowed> => {
    const card = cardOf(await deps.cards(), input.card);
    if (card === undefined) {
        return { results: input.items.map((ref) => failed(ref, "No link card by that id is saved here. Link the two sandboxes again.")) };
    }
    const offered = await linkAccounts(card);
    if (!offered.ok) {
        return { results: input.items.map((ref) => failed(ref, `${card.name} could not be asked what it lends: ${offered.message}`)) };
    }
    const results: BorrowOutcome[] = [];
    // One at a time: a copy writes a store and its manifest, and two at once would race on the same files.
    for (const ref of input.items) {
        results.push(await bringOne(deps, card, offered.value.accounts, ref));
    }
    if (results.some((result) => result.outcome === "copied")) {
        await deps.settle();
    }
    if (results.some((result) => result.outcome === "borrowed")) {
        deps.borrowed();
    }
    deps.logger.info(
        { card: card.id, copied: results.filter((r) => r.outcome === "copied").length, borrowed: results.filter((r) => r.outcome === "borrowed").length },
        "sharing: accounts brought in from a linked sandbox",
    );
    return { results };
};
