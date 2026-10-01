import {
    PERSONAL_DATA_CLASSES,
    PRIVACY_ALLOW_MAX,
    type PersonalDataClass,
    type PrivacyLedgerEntry,
    type PrivacyProvider,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";

// The privacy shield panel's arithmetic, kept free of Vue so it can be tested on its own. The policy route replaces
// the policy whole, so every change here returns a new policy built from the one on screen rather than a patch.

// The longest value the contract takes on the allow list; a longer one would be refused by the daemon as a whole save.
export const ALLOW_VALUE_MAX = 200;

// A list with one value present or absent, keeping every other member where it was. A trusted id the provider list
// no longer names (an endpoint that was removed) stays put rather than being dropped by a toggle of its neighbour.
const withMember = <T extends string>(list: readonly T[], value: T, present: boolean): T[] => {
    const others = list.filter((member) => member !== value);
    return present ? [...others, value] : others;
};

export const withTrusted = (policy: PrivacyShieldPolicy, providerId: string, trusted: boolean): PrivacyShieldPolicy => ({
    ...policy,
    trusted: withMember(policy.trusted, providerId, trusted),
});

// Classes are written back in the contract's own order, so the stored list reads the same however it was clicked.
export const withClass = (policy: PrivacyShieldPolicy, kind: PersonalDataClass, on: boolean): PrivacyShieldPolicy => ({
    ...policy,
    classes: PERSONAL_DATA_CLASSES.filter((each) => (each === kind ? on : policy.classes.includes(each))),
});

// A local model never leaves this machine, so the gateway treats it as trusted whatever the list says.
export const providerTrusted = (provider: PrivacyProvider, policy: PrivacyShieldPolicy): boolean =>
    provider.local || policy.trusted.includes(provider.id);

// The allow list as the textarea holds it: one value per line, blanks and repeats dropped, so what is saved is exactly
// the set the owner sees once the draft is re-read from the daemon.
export const allowListFrom = (text: string): string[] => [
    ...new Set(
        text
            .split(`\n`)
            .map((line) => line.trim())
            .filter((line) => line !== ``),
    ),
];

export const allowListText = (allow: readonly string[]): string => allow.join(`\n`);

// Whether two lists are the same values in the same order; the draft is unsaved exactly when they differ.
export const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

// Why a draft cannot be saved, said before the daemon refuses the whole policy for it.
export type AllowListProblem = { readonly kind: `tooLong`; readonly value: string } | { readonly kind: `tooMany`; readonly count: number };

export const allowListProblem = (values: readonly string[]): AllowListProblem | undefined => {
    if (values.length > PRIVACY_ALLOW_MAX) {
        return { kind: `tooMany`, count: values.length };
    }
    const tooLong = values.find((value) => value.length > ALLOW_VALUE_MAX);
    return tooLong === undefined ? undefined : { kind: `tooLong`, value: tooLong };
};

export interface FoundPart {
    readonly kind: PersonalDataClass;
    readonly count: number;
}

// What one logged request held, as a total and its parts in the contract's order.
export interface Found {
    readonly total: number;
    readonly parts: readonly FoundPart[];
}

// Zero counts are left out, since a class the log names with nothing found says nothing a reader can use.
export const foundIn = (entry: Pick<PrivacyLedgerEntry, `counts`>): Found => {
    const parts = PERSONAL_DATA_CLASSES.flatMap((kind) => {
        const count = entry.counts[kind] ?? 0;
        return count > 0 ? [{ kind, count }] : [];
    });
    return { total: parts.reduce((sum, part) => sum + part.count, 0), parts };
};

// The timestamp a ledger entry carries, as the number the kit's date formatters take; undefined when it cannot be
// read, so the row shows no time rather than "Invalid Date".
export const ledgerTime = (at: string): number | undefined => {
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? undefined : parsed;
};
