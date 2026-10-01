import type { PersonalDataClass } from "@intentic/sandbox-contract";
import { detectPersonalData } from "../detect.js";

const found = (text: string, kind: PersonalDataClass): string[] => detectPersonalData(text, { classes: new Set([kind]) }).map((span) => span.value);

describe("e-mail addresses", () => {
    test("a personal address is found wherever it sits", () => {
        expect(found("napisz do jan.kowalski@firma.pl jutro", "email")).toEqual(["jan.kowalski@firma.pl"]);
        expect(found("<anna+news@poczta.onet.pl>", "email")).toEqual(["anna+news@poczta.onet.pl"]);
        expect(found('{"email":"Marek.Nowak@Example.COM"}', "email")).toEqual([]);
        expect(found('{"email":"marek.nowak@nowak.co.uk"}', "email")).toEqual(["marek.nowak@nowak.co.uk"]);
        expect(found("mailto:ewa@wp.pl.", "email")).toEqual(["ewa@wp.pl"]);
    });

    // Addresses that belong to no one: masking them hides nothing and costs the model the sender of every notification.
    test("no-reply senders, GitHub's privacy addresses, example domains and ssh remotes are not personal", () => {
        for (const text of [
            "noreply@github.com",
            "no-reply@accounts.google.com",
            "do-not-reply@allegro.pl",
            "12345678+radarsu@users.noreply.github.com",
            "dependabot[bot]@users.noreply.github.com",
            "someone@example.com",
            "admin@mail.example.org",
            "git@github.com:intentic/intentic.git",
            "git@gitlab.com:group/project.git",
            "MAILER-DAEMON@smtp.example.net",
        ]) {
            expect(found(text, "email"), text).toEqual([]);
        }
    });

    test("file names and package versions with an @ are not addresses", () => {
        for (const text of ["icon@2x.png", "logo@3x.webp", "mermaid@12.0.0.patch", "lodash@4.17.21", "@types/node@22.1.0", "foo@bar"]) {
            expect(found(text, "email"), text).toEqual([]);
        }
    });
});

describe("phone numbers", () => {
    test("Polish mobiles in every common spelling", () => {
        for (const phone of [
            "+48 600 100 200",
            "+48600100200",
            "+48-600-100-200",
            "0048 600 100 200",
            "600 100 200",
            "600-100-200",
            "(+48) 600 100 200",
        ]) {
            expect(found(`zadzwoń: ${phone}.`, "phone"), phone).toEqual([phone]);
        }
    });

    test("landlines with and without the area code in brackets", () => {
        for (const phone of ["(22) 123 45 67", "22 123 45 67", "(22) 1234567", "(0-22) 123 45 67", "+48 22 123 45 67"]) {
            expect(found(`biuro ${phone}`, "phone"), phone).toEqual([phone]);
        }
    });

    test("international numbers in E.164 with separators", () => {
        expect(found("call +1 (555) 123-4567", "phone")).toEqual(["+1 (555) 123-4567"]);
        expect(found("+44 20 7946 0958", "phone")).toEqual(["+44 20 7946 0958"]);
        expect(found("+4915112345678", "phone")).toEqual(["+4915112345678"]);
    });

    // Nine bare digits are an order number or an amount as often as a phone: they need to be called one.
    test("a bare nine-digit run counts only beside a phone keyword", () => {
        expect(found("tel. 600100200", "phone")).toEqual(["600100200"]);
        expect(found("Telefon: 600100200", "phone")).toEqual(["600100200"]);
        expect(found("kom. 600.100.200", "phone")).toEqual(["600.100.200"]);
        expect(found("phone 48600100200", "phone")).toEqual(["48600100200"]);
        expect(found("zamówienie 600100200", "phone")).toEqual([]);
    });

    test("versions, dates, times, addresses and timestamps are not phones", () => {
        for (const text of [
            "v1.2.3 and 10.20.30",
            "2024-01-15 12:30:45",
            "15.01.2024",
            "192.168.100.200",
            "10.0.0.1:8080",
            "1727786400",
            "1727786400123",
            "SEARCH 101 103 208",
            "+0100",
            "123 456 789 012",
        ]) {
            expect(found(text, "phone"), text).toEqual([]);
        }
    });

    // Polish writes thousands with a space, so an amount can look exactly like a mobile number.
    test("an amount written with Polish thousands separators is not a phone", () => {
        expect(found("Przychód: 600 100 200 zł", "phone")).toEqual([]);
        expect(found("budżet 500 000 000 PLN", "phone")).toEqual([]);
        expect(found("€ 600 100 200", "phone")).toEqual([]);
    });
});
