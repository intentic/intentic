import type { PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import { impersonalAddress, phoneAt } from "./contact.js";
import { builtInLexicon, type Lexicon } from "./lexicon.js";
import { partOfDecimal, partOfNumber } from "./text.js";

// Whether a value proposed without the context it was found in is still personal data where it stands: one the vault
// learned from an earlier find and meets again, or one the local name model reads as a name. Neither brings a keyword, a
// title or a field of its own, so each is held to what its kind is wherever it stands, by the detectors' own checks: a
// number's shape and neighbours (not the places of a decimal, not a port, not a list of digits), an address that is
// somebody's, a full name no ordinary word makes up. A single word is never a name alone: nearly every name is a word in
// some language ("Mark", "Luna", a register surname that is an English word). Before 2026-10-20 the vault judged its
// values once, by rules of its own, and every misread a detector was fixed for came back through it.

const WORDS = /[\p{L}\p{N}]+/gu;

// A full name that proves itself: two words or more, none a word that is never a name, and not all of them ordinary
// words, whether names that are words too ("Kiro", "Grace") or words that are no name at all ("Crew", "Haven").
export const fullNameAlone = (value: string, lexicon: Lexicon = builtInLexicon()): boolean => {
    const infos = (value.match(WORDS) ?? []).map((word) => lexicon.info(word));
    return infos.length >= 2 && !infos.some((info) => info.never) && infos.some((info) => !info.ambiguous && !info.ordinary);
};

// A number written a digit at a time, whatever value it spells: a list (`for i in 1 2 3 …`), as a folded spelling of a
// known number would otherwise read it.
const NUMBER_SPELLED = /^[\p{N}\s_-]+$/u;
const LONE_DIGITS = /(?:^|[\s_-])\p{N}(?=[\s_-]|$)/gu;
const digitByDigit = (value: string): boolean => NUMBER_SPELLED.test(value) && (value.match(LONE_DIGITS) ?? []).length >= 2;

type Alone = (text: string, start: number, end: number, lexicon: Lexicon) => boolean;

const notInDecimal: Alone = (text, start, end) => !partOfDecimal(text, start, end);

const ALONE = {
    "national-id": (text, start, end) => !partOfNumber(text, start, end),
    "tax-id": (text, start, end) => !partOfNumber(text, start, end),
    "identity-document": notInDecimal,
    "bank-account": notInDecimal,
    "payment-card": notInDecimal,
    email: (text, start, end) => !impersonalAddress(text.slice(start, end)),
    phone: (text, start, end) => phoneAt(text, start, end, true),
    address: () => true,
    "person-name": (text, start, end, lexicon) => fullNameAlone(text.slice(start, end), lexicon),
} as const satisfies Record<PersonalDataClass, Alone>;

export const standsAlone = (kind: PersonalDataClass, text: string, start: number, end: number, lexicon: Lexicon = builtInLexicon()): boolean =>
    !digitByDigit(text.slice(start, end)) && ALONE[kind](text, start, end, lexicon);
