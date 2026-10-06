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

    // Built from their parts, so this file holds no address a detector would mask.
    const at = (local: string, domain: string): string => [local, domain].join("@");

    test("addresses on domains that never resolve, and the placeholders documentation uses, are no one's", () => {
        for (const text of [
            at("jan.nowak", "corp.test"),
            at("anna", "host.local"),
            at("ops", "example.invalid"),
            at("dev", "host.docker.internal"),
            at("piotr", "router.lan"),
            at("user", "example.pl"),
            at("jane", "acme.dev"),
            at("john", "yourcompany.com"),
        ]) {
            expect(found(text, "email"), text).toEqual([]);
        }
    });

    test("a role mailbox names a function, not a person; a person's mailbox at a company still counts", () => {
        for (const local of ["support", "kontakt", "biuro", "security", "hello", "info", "agent", "ci", "support+billing"]) {
            expect(found(at(local, "firma.pl"), "email"), local).toEqual([]);
        }
        expect(found(at("support.kowalski", "firma.pl"), "email")).toEqual([at("support.kowalski", "firma.pl")]);
        expect(found(at("jan.kowalski", "firma.pl"), "email")).toEqual([at("jan.kowalski", "firma.pl")]);
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

    // Android serials, adb targets and ssh hosts are addresses on a network, wherever a phone is mentioned around them.
    // The addresses are built from their parts, so this file holds nothing a detector would mask.
    test("an IP address, with or without its port, is not a phone even beside a phone keyword", () => {
        const ip = (...parts: number[]): string => parts.join(".");
        for (const text of [
            `phone = { serial: "${ip(192, 168, 1, 23)}:37005" }`,
            `adb connect ${ip(10, 0, 20, 5)}:5555 # the test phone`,
            `phone at ${ip(192, 168, 100, 23)}`,
            `mobile host ${ip(100, 64, 0, 7)}`,
            `tel. ${ip(192, 168, 1, 230)}`,
        ]) {
            expect(found(text, "phone"), text).toEqual([]);
        }
    });

    test("signed figures, a diff stat and a number with a port are not phones", () => {
        const nine = String(123_456_789);
        for (const text of [`phone.ts | 46 +${12} -${34}`, `mobile: +${1200} -${3400}`, `phone +${48} -${7} ${12}.${345}`, `phone ${nine}:8080`]) {
            expect(found(text, "phone"), text).toEqual([]);
        }
    });

    // North America, Russia and Poland number to a fixed length; a plus before a longer or shorter run is a timestamp
    // or a signed figure, and the 555 numbers and impossible area codes are nobody's line.
    test("an international number must have its country's length where that length is fixed, and a line it can reach", () => {
        expect(found(`offset +${1_728_201_600_123}`, "phone")).toEqual([]);
        expect(found(`delta +${1_728_201_600}`, "phone")).toEqual([]);
        expect(found(`phone +${48_601_234_567_8}`, "phone")).toEqual([]);
        expect(found(`call +1 ${212} ${555} ${4567}`, "phone")).toEqual([]);
        expect(found(`call (${212}) ${555}-${1234}`, "phone")).toEqual([]);
        expect(found(`call +1 (${123}) ${456}-${7890}`, "phone")).toEqual([]);
    });

    test("a nine-digit amount is not a phone, even beside a phone keyword", () => {
        const nine = String(123_456_789);
        expect(found(`phone build: ${nine} bytes`, "phone")).toEqual([]);
        expect(found(`mobile revenue $${nine}`, "phone")).toEqual([]);
    });

    test("a number that is part of a slug or a host name is not a phone", () => {
        const dashed = [601, 234, 567].join("-");
        expect(found(`host ip-${dashed}.compute.internal`, "phone")).toEqual([]);
        expect(found(`phone build-${dashed}`, "phone")).toEqual([]);
        expect(found(`phone ${dashed}.example.net`, "phone")).toEqual([]);
    });

    // Polish writes thousands with a space, so an amount can look exactly like a mobile number.
    test("an amount written with Polish thousands separators is not a phone", () => {
        expect(found("Przychód: 600 100 200 zł", "phone")).toEqual([]);
        expect(found("budżet 500 000 000 PLN", "phone")).toEqual([]);
        expect(found("€ 600 100 200", "phone")).toEqual([]);
    });
});

describe("after a JSON escape", () => {
    // Raw JSON text writes a line break as `\n`; the `n` is the escape's, not the first letter of the address or a digit's
    // neighbour.
    test("an address and a phone right after an escaped line break are found as themselves", () => {
        const mail = `${["jan", "nowak"].join(".")  }@` + `firma.pl`;
        expect(found(`{"body":"Hi\\n${mail}"}`, "email")).toEqual([mail]);
        expect(found(`{"body":"tel.\\n601 234 567"}`, "phone")).toEqual(["601 234 567"]);
    });
});

describe("spellings a detector used to miss", () => {
    const mail = `${["jan", "kowalski"].join(".")  }@` + `gmail.com`;

    test("an address with its @ written as %40 or \\u0040 is an address", () => {
        const encoded = mail.replace("@", "%40");
        expect(found(`GET /api?email=${encoded}&page=1`, "email")).toEqual([encoded]);
        const escaped = mail.replace("@", "\\u0040");
        expect(found(`{"e":"${escaped}"}`, "email")).toEqual([escaped]);
        expect(found("progress 100%40 done", "email")).toEqual([]);
    });

    test("nine bare digits under a JSON key that names a phone are a phone, and not under any other", () => {
        expect(found(JSON.stringify({ mobileNumber: "601234567" }), "phone")).toEqual(["601234567"]);
        expect(found(JSON.stringify({ contact_phone: "601234567" }), "phone")).toEqual(["601234567"]);
        expect(found(JSON.stringify({ orderNumber: "601234567" }), "phone")).toEqual([]);
    });

    test("a North American number with its area code in brackets is a phone", () => {
        expect(found("call (555) 123-4567 today", "phone")).toEqual(["(555) 123-4567"]);
        expect(found("call (555)123-4567 today", "phone")).toEqual(["(555)123-4567"]);
        expect(found("f(555) 123-4567", "phone")).toEqual([]);
    });
});
