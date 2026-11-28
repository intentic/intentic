import { S2S_CLAIM_KINDS, S2S_CLAIM_METHODS, type S2sClaims } from "@intentic/sandbox-contract/schemas/s2s";
import { t } from "@intentic/ui/i18n";

// What a vouch claims, in words: each well-known claim's label and its known values (a person, an organisation; checked in
// person, by a document…), and any other claim by its own name and value as the issuer wrote them. One table, so the
// Identity section, a contact's vouch form and a thread name a claim alike.

/** A claim's label: a well-known one in words, any other by its own name. */
export const claimLabel = (key: string): string => {
    switch (key) {
        case `kind`:
            return t(`sandbox.messages.claims.kind`);
        case `verifiedBy`:
            return t(`sandbox.messages.claims.verifiedBy`);
        case `country`:
            return t(`sandbox.messages.claims.country`);
        case `over18`:
            return t(`sandbox.messages.claims.over18`);
        case `displayName`:
            return t(`sandbox.messages.claims.displayName`);
        case `organisation`:
            return t(`sandbox.messages.claims.organisation`);
        default:
            return key;
    }
};

const kindWord = (value: string): string | undefined => {
    switch (value) {
        case `person`:
            return t(`sandbox.messages.claims.kinds.person`);
        case `organisation`:
            return t(`sandbox.messages.claims.kinds.organisation`);
        default:
            return undefined;
    }
};

const methodWord = (value: string): string | undefined => {
    switch (value) {
        case `in-person`:
            return t(`sandbox.messages.claims.methods.inPerson`);
        case `document`:
            return t(`sandbox.messages.claims.methods.document`);
        case `domain`:
            return t(`sandbox.messages.claims.methods.domain`);
        case `employment`:
            return t(`sandbox.messages.claims.methods.employment`);
        default:
            return undefined;
    }
};

/** A claim's value in words: a known kind or method by its name, a yes/no as yes or no, anything else as written. */
export const claimValue = (key: string, value: S2sClaims[string]): string => {
    if (value === true || value === false) {
        return value ? t(`sandbox.messages.claims.yes`) : t(`sandbox.messages.claims.no`);
    }
    const written = String(value);
    return (key === `kind` ? kindWord(written) : key === `verifiedBy` ? methodWord(written) : undefined) ?? written;
};

/** The choices a well-known claim offers, each its value and words; none for a claim typed freely. */
export const claimChoices = (key: string): readonly { readonly value: string; readonly label: string }[] => {
    if (key === `kind`) {
        return S2S_CLAIM_KINDS.map((value) => ({ value, label: kindWord(value) ?? value }));
    }
    return key === `verifiedBy` ? S2S_CLAIM_METHODS.map((value) => ({ value, label: methodWord(value) ?? value })) : [];
};
