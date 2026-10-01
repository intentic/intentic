import { cardIssuerPlausible, ibanLength, ibanValid, idCardValid, luhnValid, nipValid, nrbValid, passportValid, peselValid } from "./checksums.js";
import { digitsOf, type Emit, isWordChar, keywordBefore, partOfNumber } from "./text.js";

// Checksummed identifiers: PESEL, NIP, Polish ID card and passport numbers, IBAN and NRB accounts, payment cards. Each
// pattern only proposes; the checksum decides. Every pattern refuses a match that is part of a longer run of letters
// or digits, so a fragment of a hash, a UUID or a longer number is never read as an identifier.

const PESEL = /(?<![\p{L}\p{N}_])\d{11}(?![\p{L}\p{N}_])/gu;

export const findPesel = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(PESEL)) {
        const start = match.index;
        const end = start + match[0].length;
        if (!partOfNumber(text, start, end) && peselValid(match[0])) {
            emit(start, end, "national-id");
        }
    }
};

// NIP written as the tax office prints it (123-456-78-90 or 123-45-67-890), with spaces, or bare, optionally with the
// EU VAT prefix. The separator must be the same throughout.
const NIP = /(?<![\p{L}\p{N}_])(PL ?)?(\d{3}([- ]?)\d{3}\3\d{2}\3\d{2}|\d{3}([- ]?)\d{2}\4\d{2}\4\d{3})(?![\p{L}\p{N}_]|[- ]\d)/gu;
const NIP_KEYWORD = /(?<!\p{L})(?:nip|vat(?:[- ]?id)?|tax[- ]?id|vatin)(?!\p{L})/iu;

export const findNip = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(NIP)) {
        const start = match.index;
        const end = start + match[0].length;
        const dashed = (match[3] ?? match[4]) === "-";
        // A bare or spaced 10-digit run passes the checksum about one time in eleven, and unix timestamps are 10 digits:
        // it is a NIP only when it says so.
        const vouched = dashed || match[1] !== undefined || keywordBefore(text, start, NIP_KEYWORD);
        if (vouched && !partOfNumber(text, start, end) && nipValid(digitsOf(match[2] ?? ""))) {
            emit(start, end, "tax-id");
        }
    }
};

// Upper case only: lowercase letter-and-digit runs are identifiers in code far more often than documents.
const ID_CARD = /(?<![\p{L}\p{N}_])[A-Z]{3} ?\d{6}(?![\p{L}\p{N}_])/gu;
const PASSPORT = /(?<![\p{L}\p{N}_])[A-Z]{2} ?\d{7}(?![\p{L}\p{N}_])/gu;
// "EUR 150000" has an ID card's shape and passes its check one time in ten; an amount is not a document.
const CURRENCY = /^(?:PLN|EUR|USD|GBP|CHF|JPY|CNY|CZK|SEK|NOK|DKK|HUF|UAH|RUB|CAD|AUD|NZD|RON|BGN|TRY|INR|BRL|MXN|ZAR|HKD|SGD|KRW|ILS|AED)/;

export const findIdentityDocuments = (text: string, emit: Emit): void => {
    for (const [pattern, valid] of [
        [ID_CARD, idCardValid],
        [PASSPORT, passportValid],
    ] as const) {
        for (const match of text.matchAll(pattern)) {
            if (!CURRENCY.test(match[0]) && valid(match[0].replace(" ", ""))) {
                emit(match.index, match.index + match[0].length, "identity-document");
            }
        }
    }
};

// An IBAN is proposed generously (any run of letters, digits and single spaces after a country code and two digits)
// and then cut to the length its country prescribes, so a following word in capitals does not spoil it.
const IBAN = /(?<![\p{L}\p{N}_])([A-Z]{2})\d{2}(?: ?[A-Z0-9]){10,30}/gu;
// A bare NRB: 26 digits, usually printed 2 + 6 groups of 4.
const NRB = /(?<![\p{L}\p{N}_])\d{2}(?: ?\d{4}){6}(?![\p{L}\p{N}_]| \d)/gu;

const ibanEnd = (text: string, start: number, length: number): number | undefined => {
    let seen = 0;
    let index = start;
    while (index < text.length && seen < length) {
        if (text[index] !== " ") {
            seen += 1;
        }
        index += 1;
    }
    return seen === length && !isWordChar(text[index]) ? index : undefined;
};

export const findBankAccounts = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(IBAN)) {
        const length = ibanLength(match[1] ?? "");
        const end = length === undefined ? undefined : ibanEnd(text, match.index, length);
        if (end !== undefined && ibanValid(text.slice(match.index, end).replaceAll(" ", ""))) {
            emit(match.index, end, "bank-account");
        }
    }
    for (const match of text.matchAll(NRB)) {
        if (nrbValid(digitsOf(match[0]))) {
            emit(match.index, match.index + match[0].length, "bank-account");
        }
    }
};

// 13 to 19 digits, bare or grouped with spaces or dashes, and not the middle of a longer grouped run.
const CARD = /(?<![\p{L}\p{N}_]|\d[ -])\d(?:[ -]?\d){12,18}(?![\p{L}\p{N}_]|[ -]\d)/gu;

// Grouped the way a card is printed: one separator throughout, four digits first, then groups of three to six (16
// digits as 4-4-4-4, Amex as 4-6-5, 19 digits ending in a group of three).
const groupedLikeCard = (value: string): boolean => {
    const separators = new Set(value.replace(/\d/g, ""));
    if (separators.size === 0) {
        return true;
    }
    if (separators.size > 1) {
        return false;
    }
    const groups = value.split(/[ -]/);
    return groups[0]?.length === 4 && groups.slice(1).every((group) => group.length >= 3 && group.length <= 6);
};

export const findPaymentCards = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(CARD)) {
        const digits = digitsOf(match[0]);
        if (groupedLikeCard(match[0]) && cardIssuerPlausible(digits) && luhnValid(digits)) {
            emit(match.index, match.index + match[0].length, "payment-card");
        }
    }
};
