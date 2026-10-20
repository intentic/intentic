import { allowKey, PERSONAL_DATA_CLASSES, type PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";
import { type Candidate, createGate, detectPersonalData, type SpanSource } from "../detect.js";
import { iban, luhn, pesel } from "./ids.testing.js";

// THE LABELLED CORPUS: what the shield must find and what it must leave, in each language the product ships (en, pl, de,
// es, fr), drawn from what the owner saw masked that was no one's (2026-10-06 → 2026-10-13: "Drop" as a person, an IP
// address as a phone, "Mark", "Any", "Luna", "Grace", a shell loop's digits, a float's places as a card, a product's
// two-word name) and from what must never get through. Every source of candidates is held to it, not only the detectors:
// a value the vault learned and the local name model's guess pass the same gate, so a misread fixed here cannot return
// through either. Values are synthetic and built from their parts, so this file holds nothing a detector masks whole.

const ALL = new Set(PERSONAL_DATA_CLASSES);
const finds = (text: string): string[] => detectPersonalData(text, { classes: ALL }).map((span) => `${span.class}:${span.value}`);

const words = (...parts: readonly string[]): string => parts.join(" ");
const mail = (local: string, domain: string): string => [local, domain].join("@");

const PERSON = words("Jan", "Kowalski");
const OTHER = words("Anna", "Nowak");
const MOBILE = words("512", "345", "678");
const SPANISH = words("+34", "612", "345", "678");
const CARD = luhn("411111111111111").replace(/(\d{4})(?=\d)/gu, "$1 ");
const PERSONAL_MAIL = mail("jan.kowalski", "onet.pl");

// Text in which nothing is anybody's, whatever it looks like.
const NOBODY = {
    en: [
        "Drop the table before running the migration.",
        "Mark this task as done when the build passes.",
        "Any value works here; Luna is the image viewer we ship.",
        "Grace period: 30 days after the plan ends.",
        'The device answered from serial: "192.168.1.20:37005" after the reboot.',
        "ping 10.0.0.1 and phone home at 127.0.0.1:8080",
        "for i in 1 2 3 4 5 6 7 8 9; do echo $i; done",
        "tel. 123 456 789 is the placeholder the form shows",
        '{"start": 0.12, "end": 0.5589999999999999, "ratio": 0.153846153846153846}',
        '{"createdAt": 1727786400123, "updatedAt": "+1727786400123"}',
        "Co-authored-by: Claude Opus 4.5 <noreply@anthropic.com>",
        "We moved the assets to Poly Haven and posted it on Job Listings; Kiro Crew ships the CLI.",
        "Victoria Station, Notre-Dame Cathedral and San Francisco Bay",
        "Jan, Feb, Mar, Apr, May, Jun",
        " 12 files changed, +340 -128 lines",
        `write to ${mail("support", "firma.pl")} or ${mail("noreply", "github.com")}`,
    ],
    pl: [
        "Róża wiatrów pokazuje kierunek, a Marek to tylko imię w przykładzie.",
        "Zapłać 123 456 789 zł do końca miesiąca.",
        "Wersja 3.85010112345 przeszła testy.",
        "Kasia, Ola i Basia to zdrobnienia.",
    ],
    de: ["Max. Anzahl der Versuche: 3", "Rosa Hintergrund für Warnungen, Mark als Währung.", "Bitte die Gnadenfrist beachten."],
    es: ["Luna llena esta noche.", "Rosa es el color del botón.", "Ruta de acceso: /usr/local/bin"],
    fr: ["Pierre angulaire du projet.", "Rose pâle pour les alertes.", "Ana est un mot dans plusieurs langues."],
} as const satisfies Record<string, readonly string[]>;

// Text in which something is somebody's, and exactly what.
const SOMEBODY = {
    en: [
        [`Signed off by ${PERSON} yesterday.`, [`person-name:${PERSON}`]],
        [`Call me on ${MOBILE} or mail ${PERSONAL_MAIL}.`, [`phone:${MOBILE}`, `email:${PERSONAL_MAIL}`]],
        [`card: ${CARD}`, [`payment-card:${CARD}`]],
    ],
    pl: [
        [`Pani ${OTHER}, PESEL ${pesel(1985, 3, 12)}, tel. ${MOBILE}.`, [`person-name:${OTHER}`, `national-id:${pesel(1985, 3, 12)}`, `phone:${MOBILE}`]],
        [`"lastName": "Kowalski"`, ["person-name:Kowalski"]],
    ],
    de: [[`IBAN: ${iban("DE", "370400440532013000")}`, [`bank-account:${iban("DE", "370400440532013000")}`]]],
    es: [[`Llámame al ${SPANISH}`, [`phone:${SPANISH}`]]],
    fr: [[`IBAN ${iban("FR", "20041010050500013M02606")}`, [`bank-account:${iban("FR", "20041010050500013M02606")}`]]],
} as const satisfies Record<string, readonly (readonly [string, readonly string[]])[]>;

describe("the labelled corpus", () => {
    for (const [lang, texts] of Object.entries(NOBODY)) {
        test(`${lang}: nothing in ordinary text, code and tool output is anybody's`, () => {
            for (const text of texts) {
                expect([text, finds(text)]).toEqual([text, []]);
            }
        });
    }
    for (const [lang, cases] of Object.entries(SOMEBODY)) {
        test(`${lang}: what is somebody's is found, and nothing beside it`, () => {
            for (const [text, expected] of cases) {
                expect([text, finds(text)]).toEqual([text, [...expected]]);
            }
        });
    }
});

// The same values proposed without their context: the vault met them once and holds them, or the model guessed them.
const candidate = (text: string, value: string, kind: PersonalDataClass, by: SpanSource): Candidate => {
    const start = text.indexOf(value);
    return { start, end: start + value.length, class: kind, value, by };
};
const gate = createGate({ classes: ALL, allow: new Set(["acme sp. z o.o."].map(allowKey)) });
const kept = (text: string, value: string, kind: PersonalDataClass, by: SpanSource): boolean => gate.admits(text, candidate(text, value, kind, by));

describe("the gate holds a value proposed without its context to its kind", () => {
    test("a single word is no name, learned or guessed, in any language", () => {
        for (const [text, word] of [
            ["Drop the table", "Drop"],
            ["Mark this task as done", "Mark"],
            ["Any value works", "Any"],
            ["Luna llena esta noche", "Luna"],
            ["Grace period", "Grace"],
            ["ls refs/ shows kirocrew", "kirocrew"],
        ] as const) {
            expect([word, kept(text, word, "person-name", "learned"), kept(text, word, "person-name", "model")]).toEqual([word, false, false]);
        }
    });

    test("a product's two-word name is no person's; a full name is, wherever it comes back", () => {
        for (const product of ["Kiro Crew", "Poly Haven", "Job Listings"]) {
            expect([product, kept(`see ${product} docs`, product, "person-name", "model")]).toEqual([product, false]);
        }
        expect(kept(`/home/${PERSON} wrote it`, PERSON, "person-name", "learned")).toBe(true);
    });

    test("a number is held to its shape and its neighbours, as the detectors hold it", () => {
        const bare = MOBILE.replaceAll(" ", "");
        expect(kept("for i in 1 2 3 4 5 6 7 8 9; do", "1 2 3 4 5 6 7 8 9", "phone", "learned")).toBe(false);
        expect(kept("echo 123456789 > counts", "123456789", "phone", "learned")).toBe(false);
        expect(kept(`host 10.0.0.1:${bare}`, bare, "phone", "learned")).toBe(false);
        expect(kept(`ratio 0.${bare}`, bare, "phone", "learned")).toBe(false);
        expect(kept(`Zapłać ${MOBILE} zł`, MOBILE, "phone", "learned")).toBe(false);
        expect(kept(`call ${bare} tonight`, bare, "phone", "learned")).toBe(true);
        expect(kept('"end": 0.5589999999999999', "5589999999999999", "payment-card", "learned")).toBe(false);
        expect(kept(`v3.${pesel(1985, 1, 1)}`, pesel(1985, 1, 1), "national-id", "learned")).toBe(false);
        expect(kept(`PESEL ${pesel(1985, 1, 1)}`, pesel(1985, 1, 1), "national-id", "learned")).toBe(true);
    });

    test("an address that belongs to no one stays no one's", () => {
        expect(kept(`from ${mail("support", "firma.pl")}`, mail("support", "firma.pl"), "email", "learned")).toBe(false);
        expect(kept(`from ${PERSONAL_MAIL}`, PERSONAL_MAIL, "email", "learned")).toBe(true);
    });

    test("the owner's own word needs no more: a value they taught or a rule of theirs is kept, unless they never mask it", () => {
        expect(kept("Drop the table", "Drop", "person-name", "taught")).toBe(true);
        expect(kept("ticket EMP-004211", "EMP-004211", "identity-document", "rule")).toBe(true);
        for (const by of ["taught", "rule", "detector", "learned", "model"] as const) {
            expect([by, kept("invoice from ACME Sp. z o.o.", "ACME Sp. z o.o.", "person-name", by)]).toEqual([by, false]);
        }
    });
});
