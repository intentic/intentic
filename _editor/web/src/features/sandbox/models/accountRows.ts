import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { formatReset } from "../../../models/providers/usageStatus";

// WHAT ONE ACCOUNT'S ROW SAYS AND OFFERS in a provider's panel (ProviderPanel.vue): who it signs in as, who on this sandbox
// connected it, which presses the reader gets on it, and the ways to connect another. Pure, so the words and the gating
// are read and tested here rather than in the template; the panel hands in what the stores and the access check say.

/** The reader, as far as changing an account goes. */
export interface AccountReader {
    // The owner or Full access: every account is theirs to change.
    readonly full: boolean;
    // Given AI accounts of their own (sandbox-contract members.ts `ownAccounts`): the accounts they connected are theirs to
    // rename, sign in again and disconnect, and nobody else's are.
    readonly ownAccounts: boolean;
    // The address they signed in with, which is what the sandbox records as an account's connector.
    readonly email: string | undefined;
}

const sameAddress = (one: string | undefined, other: string | undefined): boolean =>
    one !== undefined && other !== undefined && one.trim() !== `` && one.trim().toLowerCase() === other.trim().toLowerCase();

/** Whether the reader connected this account themselves, by the address the sandbox recorded for it. */
const connectedByReader = (account: Pick<OauthAccount, `connectedBy`>, email: string | undefined): boolean =>
    sameAddress(account.connectedBy, email);

/** Whether the reader may rename, sign in again or disconnect this account: any of them with Full access, else their own. */
export const mayChangeAccount = (account: Pick<OauthAccount, `connectedBy`>, reader: AccountReader): boolean =>
    reader.full || (reader.ownAccounts && connectedByReader(account, reader.email));

/** Who connected it, where a person on this sandbox did: the reader is "you", anyone else their address. */
export const connectorNote = (connectedBy: string | undefined, viewer: string | undefined): string | undefined => {
    if (connectedBy === undefined || connectedBy.trim() === ``) {
        return undefined;
    }
    return sameAddress(connectedBy, viewer)
        ? t(`sandbox.aiAccountSection.connectedByYou`)
        : t(`sandbox.aiAccountSection.connectedBy`, { email: connectedBy.trim() });
};

/** The names more than one of these accounts shows under, which their rows tell apart some other way. */
export const ambiguousLabels = (accounts: readonly Pick<OauthAccount, `label`>[]): ReadonlySet<string> => {
    const seen = new Map<string, number>();
    for (const account of accounts) {
        seen.set(account.label, (seen.get(account.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
};

/**
 * Beside the name: who the account signs in as, or (if unknown and the name is ambiguous) when it connected. Drops a
 * repeat of the name and the provider's email-based personal organisation name.
 */
export const identityNote = (
    account: Pick<OauthAccount, `email` | `organization` | `label` | `connectedAt`>,
    ambiguous: ReadonlySet<string>,
    now: number = Date.now(),
): string | undefined => {
    const personalOrganization =
        account.email !== undefined && account.organization?.trim().toLowerCase() === `${account.email.trim()}'s organization`.toLowerCase();
    const identity = [account.email, personalOrganization ? undefined : account.organization].filter(
        (part) => part !== undefined && part !== account.label,
    );
    if (identity.length > 0) {
        return identity.join(` · `);
    }
    return ambiguous.has(account.label) ? t(`sandbox.aiAccountSection.connectedAgo`, { ago: timeAgo(account.connectedAt, { now, days: true }) }) : undefined;
};

// Why a dimmed row is dimmed: a spent allowance and when it reopens, or a bench that lifts by itself and when.
export const waitingLine = (state: AccountState): string | undefined => {
    if (state.kind === `spent`) {
        return state.reopensAt === undefined
            ? t(`sandbox.aiAccountSection.allowanceUsedUp`)
            : t(`sandbox.aiAccountSection.allowanceUsedUpReopens`, { when: formatReset(state.reopensAt) });
    }
    if (state.kind === `blocked` && state.fix === `wait`) {
        // The sentence's own stop is the template's to put, so a provider's full stop never doubles it.
        const reason = state.reason.replace(/[.!\s]+$/, ``);
        return state.until === undefined
            ? t(`sandbox.aiAccountSection.restingFor`, { reason })
            : t(`sandbox.aiAccountSection.restingUntil`, { reason, when: formatReset(state.until) });
    }
    return undefined;
};

/** The quiet facts beside a row's name as one line, or nothing when there are none. */
export const rowNote = (parts: readonly (string | undefined)[]): string | undefined =>
    parts.filter((part): part is string => part !== undefined && part !== ``).join(` · `) || undefined;

/** One button that connects an account here. */
export interface ConnectWay {
    readonly via: `native` | `routed`;
    readonly variant: string | undefined;
    readonly key: string;
    readonly label: string;
}

export interface WayFacts {
    // The provider's default sign-in, by what it connects, where it holds one; `addable` is false once Grok's single one is in.
    readonly native?: { readonly name: string; readonly addable: boolean } | undefined;
    // Each loop's own sign-in (Grok Build, Kimi CLI), by its variant and what it connects.
    readonly doors: readonly { readonly door: string; readonly name: string }[];
    // The translator's subscription, by what it connects, where the provider has one.
    readonly routed?: string | undefined;
    // Which sign-ins the reader may start: the provider's own (`accounts.start`), the translator's (`translator.connect`).
    readonly may: { readonly native: boolean; readonly routed: boolean };
    // Nothing connected here yet, which makes a lone way plain "Connect".
    readonly empty: boolean;
}

/**
 * The ways in the reader may take, each a button. One for nearly every provider, named for what it connects only where
 * there are several (Grok's three, Kimi's two), since "Connect" twice would ask the reader to guess. A way the reader may
 * not start is not drawn at all: the sandbox would only refuse it.
 */
export const connectWays = (facts: WayFacts): readonly ConnectWay[] => {
    const native = facts.may.native
        ? [
              ...(facts.native?.addable === true ? [{ via: `native` as const, variant: undefined, name: facts.native.name }] : []),
              ...facts.doors.map((door) => ({ via: `native` as const, variant: door.door, name: door.name })),
          ]
        : [];
    const routed = facts.may.routed && facts.routed !== undefined ? [{ via: `routed` as const, variant: undefined, name: facts.routed }] : [];
    // Counted with Grok's default even once it is in, so the other buttons keep the names they had.
    const several = (facts.may.native ? (facts.native === undefined ? 0 : 1) + facts.doors.length : 0) + routed.length > 1;
    return [...native, ...routed].map((way) => ({
        via: way.via,
        variant: way.variant,
        key: `${way.via}:${way.variant ?? ``}`,
        label: several
            ? t(`connect.providerPanel.connectWay`, { way: way.name })
            : facts.empty
              ? t(`ui.action.connect`)
              : t(`sandbox.aiAccountSection.addAnotherAccount`),
    }));
};
