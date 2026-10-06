import type { PersonalDataClass } from "@intentic/sandbox-contract";
import { idCardValid, passportValid, peselValid } from "../checksums.js";
import { detectPersonalData } from "../detect.js";
import { corrupt, grouped, iban, idCard, luhn, nip, nrb, passport, pesel } from "./ids.testing.js";

// Checksummed identifiers: every valid number below is computed from its algorithm (ids.testing.ts), every invalid one
// is a valid one with a digit changed, so a test can only pass when the checksum itself is right.

const found = (text: string, kind: PersonalDataClass): string[] => detectPersonalData(text, { classes: new Set([kind]) }).map((span) => span.value);

describe("PESEL", () => {
    test("a valid number is found, in every century the month can encode", () => {
        for (const year of [1885, 1985, 2004, 2101, 2250]) {
            const number = pesel(year, 2, 28);
            expect(found(`PESEL: ${number}`, "national-id")).toEqual([number]);
        }
    });

    test("a changed digit breaks the checksum", () => {
        const number = pesel(1985, 1, 1);
        for (const index of [0, 5, 9, 10]) {
            expect(found(`PESEL ${corrupt(number, index)}`, "national-id")).toEqual([]);
        }
    });

    // The checksum alone passes one random run in ten; the date is what rejects most of the rest.
    test("a number whose date cannot exist is not a PESEL even with a valid checksum", () => {
        expect(peselValid(pesel(1985, 2, 29))).toBe(false);
        expect(peselValid(pesel(1984, 2, 29))).toBe(true);
        expect(peselValid(pesel(1985, 4, 31))).toBe(false);
        expect(peselValid(pesel(2000, 2, 29))).toBe(true);
        expect(peselValid(pesel(1900, 2, 29))).toBe(false);
    });

    test("eleven digits inside a longer run of digits or letters are not one", () => {
        const number = pesel(1990, 6, 15);
        expect(found(`9${number}`, "national-id")).toEqual([]);
        expect(found(`${number}7`, "national-id")).toEqual([]);
        expect(found(`a3f${number}e9`, "national-id")).toEqual([]);
        expect(found(`0.${number}`, "national-id")).toEqual([]);
    });

    // Raw JSON text (a tool call's arguments, a log line of JSON) writes a line break as `\n`: the letter after the
    // backslash belongs to the escape, not to a word the number continues. An underscore joins a number to a file name.
    test("a number after a JSON escape or beside an underscore is found", () => {
        const number = pesel(1985, 3, 14);
        for (const text of [`{"o":"x\\n${number}"}`, `a\\t${number}`, `\\r\\n${number}`, `skan_${number}.pdf`, `user_${number}`, `${number}_old`]) {
            expect(found(text, "national-id"), text).toEqual([number]);
        }
    });

    test("a sqlite row carries it between pipes", () => {
        const number = pesel(1985, 1, 1);
        expect(found(`1|Jan|Kowalski|${number}|2024-01-01`, "national-id")).toEqual([number]);
    });
});

describe("NIP", () => {
    const number = nip("526025099");

    test("written as the tax office prints it, it needs nothing else", () => {
        const dashed = `${number.slice(0, 3)}-${number.slice(3, 6)}-${number.slice(6, 8)}-${number.slice(8)}`;
        const other = `${number.slice(0, 3)}-${number.slice(3, 5)}-${number.slice(5, 7)}-${number.slice(7)}`;
        expect(found(`faktura ${dashed}`, "tax-id")).toEqual([dashed]);
        expect(found(`faktura ${other}`, "tax-id")).toEqual([other]);
    });

    // A bare 10-digit run is a unix timestamp as often as anything; only a keyword or the EU prefix makes it a NIP.
    test("bare, it needs the NIP keyword or the PL prefix", () => {
        expect(found(`NIP: ${number}`, "tax-id")).toEqual([number]);
        expect(found(`nip ${number}`, "tax-id")).toEqual([number]);
        expect(found(`VAT ID PL${number}`, "tax-id")).toEqual([`PL${number}`]);
        expect(found(`kontrahent PL ${number}`, "tax-id")).toEqual([`PL ${number}`]);
        expect(found(`id ${number} created`, "tax-id")).toEqual([]);
    });

    test("a checksum that fails is not reported even with the keyword", () => {
        expect(found(`NIP: ${corrupt(number, 9)}`, "tax-id")).toEqual([]);
        expect(found(`NIP: ${corrupt(number, 2)}`, "tax-id")).toEqual([]);
    });

    test("unix timestamps are not NIPs", () => {
        const stamps = Array.from({ length: 200 }, (_, index) => String(1_700_000_000 + index * 7919)).join(" ");
        expect(found(stamps, "tax-id")).toEqual([]);
    });
});

describe("identity documents", () => {
    test("the specimen ID card and passport numbers validate", () => {
        expect(idCardValid("ABA300000")).toBe(true);
        expect(idCardValid("ZZC003483")).toBe(true);
        expect(passportValid("ZS0000177")).toBe(true);
    });

    test("an ID card number is found with or without the space", () => {
        const number = idCard("AYW", "12345");
        expect(found(`dowód ${number}`, "identity-document")).toEqual([number]);
        expect(found(`dowód ${number.slice(0, 3)} ${number.slice(3)}`, "identity-document")).toEqual([`${number.slice(0, 3)} ${number.slice(3)}`]);
    });

    test("a passport number is found", () => {
        const number = passport("EA", "765432");
        expect(found(`paszport nr ${number}.`, "identity-document")).toEqual([number]);
    });

    test("a wrong check digit, lowercase letters or a longer run are not documents", () => {
        const card = idCard("AYW", "12345");
        expect(found(corrupt(card, 3), "identity-document")).toEqual([]);
        expect(found(card.toLowerCase(), "identity-document")).toEqual([]);
        expect(found(`X${card}`, "identity-document")).toEqual([]);
        expect(found(`${card}1`, "identity-document")).toEqual([]);
        expect(found(corrupt(passport("EA", "765432"), 2), "identity-document")).toEqual([]);
    });

    // An amount in a currency has an ID card's shape; it must not be read as one even when the check digit happens to
    // fit.
    test("an amount after a currency code is not a document", () => {
        const amounts = Array.from({ length: 50 }, (_, index) => `EUR ${100_000 + index * 1237}`).join(", ");
        expect(found(amounts, "identity-document")).toEqual([]);
    });
});

describe("bank accounts", () => {
    test("an IBAN is found printed in groups of four and compact", () => {
        const pl = iban("PL", "109010140000071219812874");
        const de = iban("DE", "370400440532013000");
        expect(found(`konto ${grouped(pl)} do przelewu`, "bank-account")).toEqual([grouped(pl)]);
        expect(found(`IBAN: ${de}`, "bank-account")).toEqual([de]);
    });

    test("a capitalized word after the IBAN is not swallowed into it", () => {
        const pl = iban("PL", "109010140000071219812874");
        expect(found(`${grouped(pl)} ABCD`, "bank-account")).toEqual([grouped(pl)]);
    });

    test("a Polish NRB is found bare and grouped", () => {
        const number = nrb("109010140000071219812874");
        expect(found(`nr rachunku ${number}`, "bank-account")).toEqual([number]);
        expect(found(`nr rachunku ${grouped(number, [2, 4, 4, 4, 4, 4, 4])}`, "bank-account")).toEqual([grouped(number, [2, 4, 4, 4, 4, 4, 4])]);
    });

    test("a failed mod-97 or the wrong length is not an account", () => {
        const number = nrb("109010140000071219812874");
        expect(found(corrupt(number, 10), "bank-account")).toEqual([]);
        expect(found(corrupt(iban("PL", "109010140000071219812874"), 6), "bank-account")).toEqual([]);
        expect(found(`${number}5`, "bank-account")).toEqual([]);
    });
});

describe("payment cards", () => {
    test("Visa, Mastercard and Amex numbers are found grouped and bare", () => {
        const visa = luhn("411111111111111");
        const mastercard = luhn("555555555555444");
        const amex = luhn("37828224631000");
        expect(found(`karta ${grouped(visa)}`, "payment-card")).toEqual([grouped(visa)]);
        expect(found(`card: ${mastercard}`, "payment-card")).toEqual([mastercard]);
        expect(found(`amex ${grouped(amex, [4, 6, 5])}`, "payment-card")).toEqual([grouped(amex, [4, 6, 5])]);
        expect(found(`${visa.slice(0, 4)}-${visa.slice(4, 8)}-${visa.slice(8, 12)}-${visa.slice(12)}`, "payment-card")).toHaveLength(1);
    });

    test("a failed Luhn check, an unknown issuer or mixed separators are not cards", () => {
        const visa = luhn("411111111111111");
        expect(found(corrupt(visa, 15), "payment-card")).toEqual([]);
        expect(found(luhn("111111111111111"), "payment-card")).toEqual([]);
        expect(found(`${visa.slice(0, 4)} ${visa.slice(4, 8)}-${visa.slice(8, 12)} ${visa.slice(12)}`, "payment-card")).toEqual([]);
    });

    test("a card-shaped stretch of a longer number is not a card", () => {
        const visa = luhn("411111111111111");
        expect(found(`9999 ${grouped(visa)}`, "payment-card")).toEqual([]);
        expect(found(`${grouped(visa)} 1234`, "payment-card")).toEqual([]);
        expect(found(`${visa}12345`, "payment-card")).toEqual([]);
    });

    // Millisecond timestamps and snowflake ids are 13 to 19 digits starting with 1; no network issues those.
    test("timestamps and snowflake ids are not cards", () => {
        const ids = Array.from({ length: 100 }, (_, index) => String(1_727_786_400_000 + index * 104_729)).join("\n");
        expect(found(`${ids}\n1234567890123456789`, "payment-card")).toEqual([]);
    });
});

describe("after a JSON escape", () => {
    // The same `\n` that ends a line in raw JSON text must not glue the next value to an `n`.
    test("an account number, a card and a NIP right after an escaped line break are found", () => {
        const account = iban("PL", "109010140000071219812874");
        const card = luhn("411111111111111");
        const tax = nip("525000001");
        const dashedTax = `${tax.slice(0, 3)}-${tax.slice(3, 6)}-${tax.slice(6, 8)}-${tax.slice(8)}`;
        expect(found(`{"konto":"x\\n${account}"}`, "bank-account")).toEqual([account]);
        expect(found(`{"konto":"x\\n${account.slice(2)}"}`, "bank-account")).toEqual([account.slice(2)]);
        expect(found(`{"karta":"x\\t${card}"}`, "payment-card")).toEqual([card]);
        expect(found(`{"nip":"x\\n${dashedTax}"}`, "tax-id")).toEqual([dashedTax]);
    });
});

describe("spellings a detector used to miss", () => {
    const grouped4 = (digits: string, separator: string): string => digits.match(/.{1,4}/gu)?.join(separator) ?? digits;

    test("an IBAN in lower case, grouped with hyphens, or joined to a file name by underscores is an account", () => {
        const account = iban("PL", "109010140000071219812874");
        const dashed = `${account.slice(0, 4)}-${grouped4(account.slice(4), "-")}`;
        expect(found(`iban ${account.toLowerCase()}`, "bank-account")).toEqual([account.toLowerCase()]);
        expect(found(`iban ${dashed}`, "bank-account")).toEqual([dashed]);
        expect(found(`wyciag_${account}_old.pdf`, "bank-account")).toEqual([account]);
    });

    test("an NRB grouped with hyphens is an account, one separator throughout", () => {
        const account = nrb("109010140000071219812874");
        const dashed = `${account.slice(0, 2)}-${grouped4(account.slice(2), "-")}`;
        expect(found(`nr konta: ${dashed}`, "bank-account")).toEqual([dashed]);
        expect(found(`nr konta: ${dashed.replace("-", " ")}`, "bank-account")).toEqual([]);
    });

    test("a PESEL split once by a space or a hyphen is found where it is called a PESEL, and only there", () => {
        const number = pesel(1985, 3, 14, 4562);
        for (const separator of [" ", "-"]) {
            const split = `${number.slice(0, 6)}${separator}${number.slice(6)}`;
            expect(found(`PESEL: ${split}`, "national-id"), split).toEqual([split]);
            expect(found(`numery: ${split}`, "national-id"), split).toEqual([]);
        }
    });

    // A JSON key names its value however long it is, and in camelCase: the keyword window before a bare number is too
    // short for `taxIdentificationNumberOfCompany`, and `snippetCount` holds the letters of `nip` without saying it.
    test("a bare NIP under a JSON key that names a tax number is found, and not under one that only spells its letters", () => {
        const tax = nip("525000001");
        expect(found(JSON.stringify({ taxIdentificationNumberOfCompany: tax }), "tax-id")).toEqual([tax]);
        expect(found(JSON.stringify({ seller_vat_id: tax }), "tax-id")).toEqual([tax]);
        expect(found(JSON.stringify({ snippetCount: tax }), "tax-id")).toEqual([]);
    });
});
