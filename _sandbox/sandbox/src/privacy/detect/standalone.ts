import type { PersonalDataClass } from "@intentic/sandbox-contract";
import { findPhones, impersonalAddress } from "./contact.js";
import { wordInfo } from "./lexicon.js";

// Whether a value the detectors found once is personal data wherever it appears, so the vault may match it with none
// of the context it was found in. A name found beside a surname or in a "lastName" field is caught again alone, which
// is the point of the vault; but a word that is a name only sometimes ("Grace", a register surname that is an English
// word) would then be masked in every sentence that starts with it, and a value an older detector misread (an IP
// address taken for a phone) in every log line that holds it. Those are left to the detectors, which read context;
// their tokens still resolve.

const WORDS = /[\p{L}\p{N}]+/gu;

const nameAlone = (value: string): boolean => {
    const words = value.match(WORDS) ?? [];
    // A word that is ordinary too proves nothing alone; a full name proves itself unless every word of it is ordinary.
    return words.some((word) => {
        const info = wordInfo(word);
        return !info.ambiguous && !info.never;
    });
};

const phoneAlone = (value: string): boolean => {
    const text = `tel. ${value}`;
    let whole = false;
    findPhones(text, (start, end) => {
        whole ||= start === 5 && end === text.length;
    });
    return whole;
};

export const personalAlone = (value: string, kind: PersonalDataClass): boolean => {
    switch (kind) {
        case "person-name":
            return nameAlone(value);
        case "phone":
            return phoneAlone(value);
        case "email":
            return !impersonalAddress(value);
        default:
            return true;
    }
};
