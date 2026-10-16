// The check digits and checksums of the identifiers the detector reports. A digit run that merely has the right length
// is a timestamp, an order number or a hash fragment far more often than personal data; one whose checksum holds is
// almost always what it looks like. Every function takes the identifier compacted (no spaces or dashes).

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];
// Polish identity card: three letters and six digits, the first digit the check digit. The 7-3-1 weights skip it.
const ID_CARD_WEIGHTS = [7, 3, 1, 0, 7, 3, 1, 7, 3];
// Polish passport: two letters and seven digits, the first digit the check digit, the same 7-3-1 cycle around it.
const PASSPORT_WEIGHTS = [7, 3, 0, 1, 7, 3, 1, 7, 3];

const digitAt = (value: string, index: number): number => value.charCodeAt(index) - 48;

// A=10 … Z=35, the value documents and IBANs give letters.
const alnumValue = (ch: string): number => {
    const code = ch.charCodeAt(0);
    return code >= 65 ? code - 55 : code - 48;
};

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// PESEL encodes the century in the month: +80 for the 1800s, +0 the 1900s, +20 the 2000s, +40 the 2100s, +60 the
// 2200s. A number whose date cannot exist is not a PESEL, which rejects most random 11-digit runs the checksum lets by.
const peselDateValid = (pesel: string): boolean => {
    const yy = digitAt(pesel, 0) * 10 + digitAt(pesel, 1);
    const encodedMonth = digitAt(pesel, 2) * 10 + digitAt(pesel, 3);
    const day = digitAt(pesel, 4) * 10 + digitAt(pesel, 5);
    const offset = Math.floor(encodedMonth / 20) * 20;
    const month = encodedMonth - offset;
    const century = offset === 80 ? 1800 : 1900 + offset * 5;
    if (month < 1 || month > 12 || day < 1) {
        return false;
    }
    const days = month === 2 && isLeapYear(century + yy) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
    return day <= days;
};

export const peselValid = (pesel: string): boolean => {
    if (!/^\d{11}$/.test(pesel)) {
        return false;
    }
    let sum = 0;
    for (const [index, weight] of PESEL_WEIGHTS.entries()) {
        sum += digitAt(pesel, index) * weight;
    }
    return (10 - (sum % 10)) % 10 === digitAt(pesel, 10) && peselDateValid(pesel);
};

// NIP: the first three digits name a tax office, none of which starts with 0, so "0000000000" (whose checksum holds)
// is not one.
export const nipValid = (nip: string): boolean => {
    if (!/^[1-9]\d{9}$/.test(nip)) {
        return false;
    }
    let sum = 0;
    for (const [index, weight] of NIP_WEIGHTS.entries()) {
        sum += digitAt(nip, index) * weight;
    }
    const check = sum % 11;
    return check !== 10 && check === digitAt(nip, 9);
};

const documentValid = (value: string, weights: readonly number[], checkIndex: number): boolean => {
    let sum = 0;
    for (const [index, weight] of weights.entries()) {
        sum += alnumValue(value[index] ?? "0") * weight;
    }
    return sum % 10 === digitAt(value, checkIndex);
};

// "ABA300000" is the specimen every Polish ID card validator is checked against.
export const idCardValid = (value: string): boolean => /^[A-Z]{3}\d{6}$/.test(value) && documentValid(value, ID_CARD_WEIGHTS, 3);

// "ZS0000177" is the specimen passport's number.
export const passportValid = (value: string): boolean => /^[A-Z]{2}\d{7}$/.test(value) && documentValid(value, PASSPORT_WEIGHTS, 2);

// ISO 13616: the country code and check digits move to the end, letters become numbers, and the whole is 1 mod 97.
// Computed digit by digit, since the number is far past what a double holds exactly.
const mod97 = (value: string): number => {
    let rest = 0;
    for (const ch of value) {
        const n = alnumValue(ch);
        rest = (n >= 10 ? rest * 100 + n : rest * 10 + n) % 97;
    }
    return rest;
};

// Each country's IBAN has one length; a candidate of another length is cut or rejected before the checksum.
const IBAN_LENGTHS = new Map<string, number>(
    Object.entries({
        AD: 24,
        AE: 23,
        AL: 28,
        AT: 20,
        AZ: 28,
        BA: 20,
        BE: 16,
        BG: 22,
        BH: 22,
        BR: 29,
        BY: 28,
        CH: 21,
        CR: 22,
        CY: 28,
        CZ: 24,
        DE: 22,
        DK: 18,
        DO: 28,
        EE: 20,
        EG: 29,
        ES: 24,
        FI: 18,
        FO: 18,
        FR: 27,
        GB: 22,
        GE: 22,
        GI: 23,
        GL: 18,
        GR: 27,
        GT: 28,
        HR: 21,
        HU: 28,
        IE: 22,
        IL: 23,
        IQ: 23,
        IS: 26,
        IT: 27,
        JO: 30,
        KW: 30,
        KZ: 20,
        LB: 28,
        LC: 32,
        LI: 21,
        LT: 20,
        LU: 20,
        LV: 21,
        LY: 25,
        MC: 27,
        MD: 24,
        ME: 22,
        MK: 19,
        MR: 27,
        MT: 31,
        MU: 30,
        NL: 18,
        NO: 15,
        PK: 24,
        PL: 28,
        PS: 29,
        PT: 25,
        QA: 29,
        RO: 24,
        RS: 22,
        SA: 24,
        SC: 31,
        SD: 18,
        SE: 24,
        SI: 19,
        SK: 24,
        SM: 27,
        ST: 25,
        SV: 28,
        TL: 23,
        TN: 24,
        TR: 26,
        UA: 29,
        VA: 22,
        VG: 24,
        XK: 20,
    }),
);

export const ibanLength = (country: string): number | undefined => IBAN_LENGTHS.get(country);

export const ibanValid = (iban: string): boolean =>
    IBAN_LENGTHS.get(iban.slice(0, 2)) === iban.length && /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) && mod97(iban.slice(4) + iban.slice(0, 4)) === 1;

// A Polish NRB is the IBAN without its "PL": 26 digits, the first two the IBAN check digits.
export const nrbValid = (nrb: string): boolean => /^\d{26}$/.test(nrb) && ibanValid(`PL${nrb}`);

export const luhnValid = (digits: string): boolean => {
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
        let n = digitAt(digits, digits.length - 1 - index);
        if (index % 2 === 1) {
            n *= 2;
            if (n > 9) {
                n -= 9;
            }
        }
        sum += n;
    }
    return sum % 10 === 0;
};

const between = (value: number, low: number, high: number): boolean => value >= low && value <= high;

// Issuer prefixes and the lengths each network issues, so a Luhn-valid run that no network would print (an id
// starting with 1, a 17-digit Visa) is not reported.
export const cardIssuerPlausible = (digits: string): boolean => {
    const length = digits.length;
    const p2 = Number(digits.slice(0, 2));
    const p3 = Number(digits.slice(0, 3));
    const p4 = Number(digits.slice(0, 4));
    // Visa stopped issuing 13-digit numbers long ago, and a 13-digit run starting with 4 is far more often a German
    // phone number (49…) or an id.
    if (digits.startsWith("4")) {
        return length === 16 || length === 19;
    }
    if (between(p2, 51, 55) || between(p4, 2221, 2720)) {
        return length === 16;
    }
    if (p2 === 34 || p2 === 37) {
        return length === 15;
    }
    if (p4 === 6011 || p2 === 65 || between(p3, 644, 649) || between(p4, 3528, 3589) || p2 === 62 || between(p4, 2200, 2204)) {
        return between(length, 16, 19);
    }
    if (p2 === 36 || p2 === 38 || p2 === 39 || between(p3, 300, 305)) {
        return between(length, 14, 19);
    }
    // Maestro, which shares prefixes with the others; its rare short numbers are not worth the ids they would catch.
    if (p2 === 50 || between(p2, 56, 69)) {
        return between(length, 16, 19);
    }
    return false;
};
