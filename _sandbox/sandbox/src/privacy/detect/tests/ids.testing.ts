// Valid identifiers built from their own algorithms, so the tests never carry a transcribed number whose validity is
// taken on trust: each one is computed here from the parts a test chooses, and an invalid one is a valid one with a
// digit changed.

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

const pad = (value: number, width: number): string => String(value).padStart(width, "0");
const alnum = (ch: string): number => (ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch));

// A PESEL for a birth date and a 4-digit serial (its last digit is the sex: even for women).
export const pesel = (year: number, month: number, day: number, serial = 1234): string => {
    const centuryOffset = year < 1900 ? 80 : year < 2000 ? 0 : year < 2100 ? 20 : year < 2200 ? 40 : 60;
    const body = `${pad(year % 100, 2)}${pad(month + centuryOffset, 2)}${pad(day, 2)}${pad(serial, 4)}`;
    const sum = PESEL_WEIGHTS.reduce((total, weight, index) => total + Number(body[index]) * weight, 0);
    return `${body}${(10 - (sum % 10)) % 10}`;
};

// A NIP from its first nine digits; the caller picks digits whose check is not the invalid 10.
export const nip = (first9: string): string => {
    const sum = NIP_WEIGHTS.reduce((total, weight, index) => total + Number(first9[index]) * weight, 0);
    const check = sum % 11;
    if (check === 10) {
        throw new Error(`${first9} has no valid NIP check digit`);
    }
    return `${first9}${check}`;
};

// A Polish ID card number from its series letters and the five digits after the check digit.
export const idCard = (letters: string, digits: string): string => {
    const weights = [7, 3, 1, 7, 3, 1, 7, 3];
    const sum = [...`${letters}${digits}`].reduce((total, ch, index) => total + alnum(ch) * (weights[index] ?? 0), 0);
    return `${letters}${sum % 10}${digits}`;
};

// A Polish passport number from its two letters and the six digits after the check digit.
export const passport = (letters: string, digits: string): string => {
    const weights = [7, 3, 1, 7, 3, 1, 7, 3];
    const sum = [...`${letters}${digits}`].reduce((total, ch, index) => total + alnum(ch) * (weights[index] ?? 0), 0);
    return `${letters}${sum % 10}${digits}`;
};

const mod97 = (value: string): number => [...value].reduce((rest, ch) => (rest * (alnum(ch) >= 10 ? 100 : 10) + alnum(ch)) % 97, 0);

// An IBAN for a country and its BBAN, with the check digits computed.
export const iban = (country: string, bban: string): string => `${country}${pad(98 - mod97(`${bban}${country}00`), 2)}${bban}`;

// A Polish NRB (the IBAN without "PL") for a 24-digit bank and account number.
export const nrb = (bankAndAccount: string): string => iban("PL", bankAndAccount).slice(2);

// A card number from every digit but the last, completed with its Luhn digit.
export const luhn = (prefix: string): string => {
    for (let check = 0; check <= 9; check += 1) {
        const candidate = `${prefix}${check}`;
        let sum = 0;
        for (let index = 0; index < candidate.length; index += 1) {
            let n = Number(candidate[candidate.length - 1 - index]);
            if (index % 2 === 1) {
                n = n * 2 > 9 ? n * 2 - 9 : n * 2;
            }
            sum += n;
        }
        if (sum % 10 === 0) {
            return candidate;
        }
    }
    throw new Error("unreachable: one of ten check digits always completes a Luhn sum");
};

// The same identifier with one digit changed, which every checksum here catches.
export const corrupt = (value: string, index: number): string => {
    const digit = Number(value[index]);
    return `${value.slice(0, index)}${(digit + 1) % 10}${value.slice(index + 1)}`;
};

// Groups of four, the way banks and cards print numbers.
export const grouped = (value: string, sizes: readonly number[] = []): string => {
    if (sizes.length === 0) {
        return value.replace(/(.{4})(?=.)/g, "$1 ");
    }
    const parts: string[] = [];
    let at = 0;
    for (const size of sizes) {
        parts.push(value.slice(at, at + size));
        at += size;
    }
    return parts.join(" ");
};
