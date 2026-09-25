import type { NativeProvider, OauthAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { AccountDoor } from "../provider-module.js";

// Who an account IS, once, for every provider: the email it signs in as, within an organisation and an estate. Two stored
// accounts with one identity are one person's one seat, so a sign-in for an identity already on file lands on that
// account (same id), and a leftover duplicate from before that rule is merged into the survivor at boot, with every
// conversation and automation pinned to it moved across. A named account that is gone is refused
// (harness-credentials.ts), so a duplicate row left standing would become a refused conversation.

/** The facts identity is read from, as a stored row or an arriving sign-in carries them. */
export type IdentityFacts = Pick<OauthAccount, "email" | "organization" | "variant">;

/**
 * One identity rule: undefined when the provider named no email, which is exactly when nothing can match (renaming is the
 * only way to tell such rows apart). Case-folded: providers disagree about the case of the same address.
 */
export const signInIdentity = (facts: IdentityFacts): string | undefined =>
    facts.email === undefined || facts.email.trim() === ""
        ? undefined
        : JSON.stringify([facts.email.trim().toLowerCase(), facts.organization ?? "", facts.variant ?? ""]);

/**
 * The stored account an arriving sign-in is the same person's as, or undefined for a new one. A row needing a new
 * sign-in is preferred, since that is the one the person pressed Reconnect on. The one connect path every provider takes:
 * reuse this row's id, else mint.
 */
export const sameAccount = <T extends OauthAccount>(stored: readonly T[], arriving: IdentityFacts, identityOf: (account: T) => string | undefined = signInIdentity): T | undefined => {
    const identity = signInIdentity(arriving);
    if (identity === undefined) {
        return undefined;
    }
    const matches = stored.filter((account) => identityOf(account) === identity);
    return matches.find((account) => account.needsReauth === true) ?? matches[0];
};

/** Everything the daemon keeps about an account beside its credential: its usage snapshot, refusals naming it, its observed ledger. */
export const forgetAccountState = async (
    deps: Pick<Services, "headroom" | "providerRefusals" | "observedLimits">,
    provider: NativeProvider,
    id: string,
): Promise<void> => {
    await Promise.all([deps.headroom.clear(provider, id), deps.providerRefusals.clear(provider, id), deps.observedLimits.clear(provider, id)]);
};

// Of one identity's rows, the one that goes on: a working credential over a revoked one, then the newest sign-in.
const survivorOf = (rows: readonly OauthAccount[]): OauthAccount | undefined =>
    rows.toSorted((left, right) => Number(left.needsReauth === true) - Number(right.needsReauth === true) || right.connectedAt - left.connectedAt)[0];

export interface MergedAccount {
    readonly provider: NativeProvider;
    readonly from: string;
    readonly to: string;
}

/**
 * Merges every provider's superseded rows into their survivor: conversation profiles and automation pins move to the
 * surviving id first, then the superseded account is forgotten whole. Idempotent, so it runs at every boot; after the
 * first it finds nothing, since every connect now reuses the id.
 */
export const mergeSupersededAccounts = async (
    deps: Pick<Services, "agents" | "automations">,
    doors: Partial<Record<NativeProvider, AccountDoor>>,
): Promise<readonly MergedAccount[]> => {
    const merged: MergedAccount[] = [];
    for (const [provider, door] of Object.entries(doors) as [NativeProvider, AccountDoor][]) {
        const groups = new Map<string, OauthAccount[]>();
        for (const account of await door.list(false)) {
            const identity = door.identityOf(account);
            if (identity !== undefined) {
                groups.set(identity, [...(groups.get(identity) ?? []), account]);
            }
        }
        for (const rows of groups.values()) {
            const survivor = survivorOf(rows);
            for (const row of rows) {
                if (survivor === undefined || row.id === survivor.id) {
                    continue;
                }
                await repointPins(deps, row.id, survivor.id);
                await door.forget(row.id);
                merged.push({ provider, from: row.id, to: survivor.id });
            }
        }
    }
    return merged;
};

// Conversations and automations naming the superseded id name the survivor instead. Account ids are minted per sandbox
// and never reused across providers, so the id alone says which pins are its.
const repointPins = async (deps: Pick<Services, "agents" | "automations">, from: string, to: string): Promise<void> => {
    await deps.agents.repointAccount(from, to);
    for (const record of await deps.automations.list()) {
        if (record.account === from) {
            const { runs: _runs, ...automation } = record;
            await deps.automations.upsert({ ...automation, account: to });
        }
    }
};
