import type { PersonalDataClass, PrivacyReplacement } from "@intentic/sandbox-contract/schemas/privacy";

// What a wire format's walker is handed for one request: the text pass, the binary passes, and a tally. The walkers know
// where each protocol keeps its text; this knows what to do with it. Kept apart from both so each protocol is a pure
// function of a body and a shield, testable with a fake.

export interface ShieldTally {
    // Kinds found in what this request carried, summed over every string the walker handed in.
    readonly counts: Partial<Record<PersonalDataClass, number>>;
    // Images the shield changed: personal data painted over, or held back because they could not be read.
    images: number;
    // Documents the shield read: a PDF sent as its pages painted over, another document as its masked text, or either
    // held back.
    documents: number;
    // The first values replaced, one per token, for the log (PRIVACY_REPLACEMENTS_MAX of them at most).
    readonly replacements: PrivacyReplacement[];
}

// An image or document a walker found, as base64 with its media type.
export interface ShieldBinary {
    readonly mediaType: string;
    readonly data: string;
}

export type ImageVerdict = "keep" | { readonly text: string } | { readonly image: ShieldBinary };

// What a document becomes: `keep` sends it as it is, `document` sends that PDF in its place (its pages as pictures,
// personal data painted over), `text` sends that text instead (another format's masked text, or a note holding it back).
export type DocumentVerdict = "keep" | { readonly text: string } | { readonly document: ShieldBinary };

export interface RequestShield {
    // One string bound for the provider, masked. The same input gives the same output for as long as the vault holds,
    // which is what keeps a provider's prompt cache and a signed transcript stable across requests.
    readonly mask: (text: string) => Promise<string>;
    // An image bound for the provider: `keep` sends it as it is, `image` sends that image in its place (the same picture
    // with its personal data painted over), `text` sends a note instead of any picture.
    readonly image: (image: ShieldBinary) => Promise<ImageVerdict>;
    // A document bound for the provider (a PDF, an office file, plain text), inline or by address (mediaType "url").
    readonly document: (document: ShieldBinary) => Promise<DocumentVerdict>;
    // Appended once to the request's instructions while masking is on, so the model knows what a token is and to write
    // it back verbatim. Undefined: add nothing.
    readonly note: string | undefined;
}

// What a response's walker is handed: tokens back to the values they stand for. Pure and synchronous, so a stream can
// apply it chunk by chunk.
export type RestoreText = (text: string) => string;
