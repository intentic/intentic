import type { PersonalDataClass } from "@intentic/sandbox-contract";
import { findPhones, impersonalAddress } from "./contact.js";
import { wordInfo } from "./lexicon.js";

// Whether a value the detectors found once is personal data wherever it appears, so the vault may match it with none
// of the context it was found in. A full name found once is caught again alone, which is the point of the vault; but a
// single word never is, whatever title or field it was found after: nearly every name is a word in some language
// ("Mark", "Luna", a register surname that is an English word), and matched alone it would be masked in every sentence that
// holds it. Nor is a value an older detector misread (an IP address taken for a phone). Those are left to the
// detectors, which read context; their tokens still resolve.

const WORDS = /[\p{L}\p{N}]+/gu;

// A full name that proves itself: two words or more, none a word that is never a name, and not all of them ordinary
// words. The local name model's finds are held to it too: the model reads context, but a single capitalized word is a
// name to it as often as it is a button, a heading or the start of a sentence.
export const fullNameAlone = (value: string): boolean => {
    const infos = (value.match(WORDS) ?? []).map((word) => wordInfo(word));
    return infos.length >= 2 && !infos.some((info) => info.never) && infos.some((info) => !info.ambiguous);
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
            return fullNameAlone(value);
        case "phone":
            return phoneAlone(value);
        case "email":
            return !impersonalAddress(value);
        default:
            return true;
    }
};
