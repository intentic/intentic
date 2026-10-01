import type { PersonalDataClass } from "@intentic/sandbox-contract";

// What a wire format's walker is handed for one request: the text pass, the binary passes, and a tally. The walkers know
// where each protocol keeps its text; this knows what to do with it. Kept apart from both so each protocol is a pure
// function of a body and a shield, testable with a fake.

export interface ShieldTally {
    // Kinds found in what this request carried, summed over every string the walker handed in.
    readonly counts: Partial<Record<PersonalDataClass, number>>;
    // Images withheld or replaced by their read text.
    images: number;
    // Documents replaced by their masked text.
    documents: number;
}

// An image or document a walker found, as base64 with its media type.
export interface ShieldBinary {
    readonly mediaType: string;
    readonly data: string;
}

export interface RequestShield {
    // One string bound for the provider, masked. The same input gives the same output for as long as the vault holds,
    // which is what keeps a provider's prompt cache and a signed transcript stable across requests.
    readonly mask: (text: string) => Promise<string>;
    // An image bound for the provider: `keep` sends it as it is; otherwise the text that takes its place.
    readonly image: (image: ShieldBinary) => Promise<"keep" | { readonly text: string }>;
    // A document (a PDF) bound for the provider: `keep` sends it as it is; otherwise the masked text that takes its place.
    readonly document: (document: ShieldBinary) => Promise<"keep" | { readonly text: string }>;
    // Appended once to the request's instructions while masking is on, so the model knows what a token is and to write
    // it back verbatim. Undefined: add nothing.
    readonly note: string | undefined;
}

// What a response's walker is handed: tokens back to the values they stand for. Pure and synchronous, so a stream can
// apply it chunk by chunk.
export type RestoreText = (text: string) => string;
