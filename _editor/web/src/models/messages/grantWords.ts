import { S2S_GRANT_KINDS, type S2sGrantKind, type S2sGrantsInput } from "@intentic/sandbox-contract/schemas/s2s";
import { t } from "@intentic/ui/i18n";

// What a contact may do here, in words: the short ones a row and a contact card list, joined, and the label and hover each
// grant's switch carries. One table, so the Contacts part and the `contact` card name a grant alike.

/** The grants that are on, in the contract's order. */
const grantsOn = (grants: S2sGrantsInput): S2sGrantKind[] =>
    S2S_GRANT_KINDS.filter((kind) => (kind === `task` ? grants.task !== undefined : kind === `message` ? grants.message !== false : grants[kind] === true));

/** One grant's short word, as a list of them reads: "message, report, hand tasks". */
const grantWord = (kind: S2sGrantKind): string => {
    switch (kind) {
        case `message`:
            return t(`sandbox.messages.grants.words.message`);
        case `report`:
            return t(`sandbox.messages.grants.words.report`);
        case `task`:
            return t(`sandbox.messages.grants.words.task`);
        case `records`:
            return t(`sandbox.messages.grants.words.records`);
        case `operate`:
            return t(`sandbox.messages.grants.words.operate`);
        case `wake`:
            return t(`sandbox.messages.grants.words.wake`);
    }
};

/** The grants that are on, as a list: "message, report, hand tasks", or that it may do nothing here. */
export const grantsLine = (grants: S2sGrantsInput): string => {
    const on = grantsOn(grants);
    return on.length === 0 ? t(`sandbox.messages.grants.none`) : on.map(grantWord).join(`, `);
};

/** One grant's switch: its label, and what its hover says it lets the contact do. */
export interface GrantLabel {
    readonly label: string;
    readonly hint: string;
}
export const grantLabel = (kind: S2sGrantKind): GrantLabel => {
    switch (kind) {
        case `message`:
            return { label: t(`sandbox.messages.grants.message`), hint: t(`sandbox.messages.grants.messageHint`) };
        case `report`:
            return { label: t(`sandbox.messages.grants.report`), hint: t(`sandbox.messages.grants.reportHint`) };
        case `task`:
            return { label: t(`sandbox.messages.grants.task`), hint: t(`sandbox.messages.grants.taskHint`) };
        case `records`:
            return { label: t(`sandbox.messages.grants.records`), hint: t(`sandbox.messages.grants.recordsHint`) };
        case `operate`:
            return { label: t(`sandbox.messages.grants.operate`), hint: t(`sandbox.messages.grants.operateHint`) };
        case `wake`:
            return { label: t(`sandbox.messages.grants.wake`), hint: t(`sandbox.messages.grants.wakeHint`) };
    }
};
