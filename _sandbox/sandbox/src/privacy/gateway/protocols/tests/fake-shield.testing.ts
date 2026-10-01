import { tokenKey, tokenPattern } from "../../../tokens.js";
import type { RequestShield, RestoreText, ShieldBinary } from "../../shield-types.js";
import { isList, isRecord, type Json } from "../walk.js";

// A shield with a fixed vocabulary in place of the masker and the vault: each known value becomes its token and back.
// The values are chosen to be awkward on the way back: multibyte letters, and an address whose quotes and newline must
// be escaped inside JSON arguments.

export const VALUES: ReadonlyMap<string, string> = new Map([
    ["PERSON_1", "Jan Kowalski"],
    ["PERSON_2", "Zażółć Gęślą"],
    ["EMAIL_1", "jan.kowalski@example.pl"],
    ["BANK_ACCOUNT_3", "PL61109010140000071219812874"],
    ["ADDRESS_1", 'ul. "Długa" 5\n00-001 Warszawa'],
]);

// Longest first, so a value never loses to a shorter one inside it.
const BY_LENGTH = [...VALUES].toSorted(([, a], [, b]) => b.length - a.length);

export const mask = (text: string): string => BY_LENGTH.reduce((masked, [key, value]) => masked.replaceAll(value, `⟦${key}⟧`), text);

export const restore: RestoreText = (text) =>
    text.replace(tokenPattern(), (token, label?: string, index?: string, bracketLabel?: string, bracketIndex?: string) => {
        const key = tokenKey(label ?? bracketLabel ?? "", index ?? bracketIndex ?? "");
        return VALUES.get(key) ?? token;
    });

export const NOTE = "Values written ⟦LIKE_1⟧ are placeholders: write them back exactly.";

// What the shield says about an image or document: keep it, or the text that replaces it.
export const IMAGE_TEXT = "[image withheld: a photo of ⟦PERSON_1⟧]";
export const DOCUMENT_TEXT = "Invoice for ⟦PERSON_1⟧, account ⟦BANK_ACCOUNT_3⟧.";

export interface FakeShield extends RequestShield {
    readonly images: ShieldBinary[];
    readonly documents: ShieldBinary[];
}

export interface FakeShieldOptions {
    readonly note?: string | undefined;
    readonly keep?: boolean;
}

// `note: undefined` means masking runs without a note, so it must not fall back to the default.
export const fakeShield = (options: FakeShieldOptions = {}): FakeShield => {
    const note = "note" in options ? options.note : NOTE;
    const keep = options.keep ?? false;
    const images: ShieldBinary[] = [];
    const documents: ShieldBinary[] = [];
    return {
        images,
        documents,
        note,
        mask: async (text) => mask(text),
        image: async (image) => {
            images.push(image);
            return keep ? "keep" : { text: IMAGE_TEXT };
        },
        document: async (document) => {
            documents.push(document);
            return keep ? "keep" : { text: DOCUMENT_TEXT };
        },
    };
};

// Freezes a fixture all the way down, so a walker that edits its input in place throws instead of passing.
export const deepFreeze = <T extends Json>(value: T): T => {
    if (isList(value) || isRecord(value)) {
        for (const item of Object.values(value)) {
            deepFreeze(item);
        }
        Object.freeze(value);
    }
    return value;
};

// A value inside a body by its path, or undefined; walks lists by position and objects by key, so tests read a
// result without asserting its type.
export const at = (value: Json | undefined, ...path: readonly (string | number)[]): Json | undefined =>
    path.reduce<Json | undefined>((node, step) => {
        if (isList(node)) {
            return node[Number(step)];
        }
        return isRecord(node) ? node[String(step)] : undefined;
    }, value);
