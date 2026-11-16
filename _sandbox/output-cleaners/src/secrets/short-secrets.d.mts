// A stored value under the length floor, with the name it masks to.
export interface ShortSecretTarget {
    readonly name: string;
    readonly value: string;
}

// The short values worth a contextual pass: non-empty, one line, trimmed, under `floor`.
export const shortSecretTargets: (named: readonly { readonly name: string; readonly value: string }[], floor: number) => ShortSecretTarget[];

// Replaces each short value with `replacement(name)` only where it stands in a secret-like context (after a key naming a
// secret or the secret itself, as a password flag's argument, as a URL's userinfo password).
export const maskShortSecrets: (text: string, targets: readonly ShortSecretTarget[], replacement: (name: string) => string) => string;

// A mask entry: an exact target, or (`contextual`) a short value masked only in a secret-like context.
export interface MaskEntry {
    readonly target: string;
    readonly replacement: string;
    readonly name?: string;
    readonly contextual?: boolean;
}

// The short values as mask entries beside the exact ones, marked `contextual` so nothing splits on them.
export const contextualEntries: (
    named: readonly { readonly name: string; readonly value: string }[],
    floor: number,
    reference: (name: string) => string,
) => (MaskEntry & { readonly name: string; readonly contextual: true })[];

// Masks a text against a list of mask entries: each exact target wherever it stands, then the `contextual` ones only
// where their context names a secret.
export const maskValues: (text: string, entries: readonly MaskEntry[], reference: (name: string) => string) => string;
