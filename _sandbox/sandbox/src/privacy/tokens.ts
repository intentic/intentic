import type { PersonalDataClass } from "@intentic/sandbox-contract";

// The tokens personal data becomes on its way to an untrusted provider: `⟦PERSON_12⟧`. Typed, so the model still knows
// it is reading a person or an account number; numbered, so the same value is the same token every time and the
// provider's prompt cache keeps; bracketed with characters ordinary text, code and shells never use, so putting the
// real values back can't touch anything that was not a token. A model that rewrites the brackets as `[[PERSON_12]]` is
// read too, since the tokens are only ever looked up, never trusted for what they say.

export const TOKEN_OPEN = "⟦";
export const TOKEN_CLOSE = "⟧";

// Each class's label inside the token; uppercase ASCII and underscores, so the label can't itself be read as data.
export const TOKEN_LABEL: Readonly<Record<PersonalDataClass, string>> = {
    "person-name": "PERSON",
    "national-id": "NATIONAL_ID",
    "tax-id": "TAX_ID",
    "identity-document": "ID_DOCUMENT",
    "bank-account": "BANK_ACCOUNT",
    "payment-card": "CARD",
    email: "EMAIL",
    phone: "PHONE",
    address: "ADDRESS",
};

export const tokenOf = (label: string, index: number): string => `${TOKEN_OPEN}${label}_${index}${TOKEN_CLOSE}`;

// Every token in a text, in either spelling; `label` and `index` name it whichever brackets it wore. Global, so callers
// must not share its lastIndex: each use builds its own from the source.
export const TOKEN_SOURCE = String.raw`⟦([A-Z][A-Z_]*?)_(\d{1,7})⟧|\[\[([A-Z][A-Z_]*?)_(\d{1,7})\]\]`;
export const tokenPattern = (): RegExp => new RegExp(TOKEN_SOURCE, "gu");

// The canonical key a token is stored under, whichever brackets the model wrote it in.
export const tokenKey = (label: string, index: string | number): string => `${label}_${String(index)}`;

// The longest a token can be written, so a stream can hold back an unfinished one without holding back prose.
export const TOKEN_MAX_LENGTH = 48;
