import { PERSONAL_DATA_CLASSES, type PersonalDataClass } from "@intentic/sandbox-contract";
import { detectPersonalData, mergeSpans, normalizeAllowed, type PersonalDataSpan } from "../detect.js";
import { iban, luhn, nip, pesel } from "./ids.testing.js";

const everything = new Set(PERSONAL_DATA_CLASSES);
const span = (start: number, end: number, kind: PersonalDataClass, text: string): PersonalDataSpan => ({
    start,
    end,
    class: kind,
    value: text.slice(start, end),
});

// What the masker relies on: spans in order, never overlapping, each value exactly the text it covers.
const wellFormed = (text: string, spans: readonly PersonalDataSpan[]): boolean =>
    spans.every((found, index) => found.value === text.slice(found.start, found.end) && (index === 0 || (spans[index - 1]?.end ?? 0) <= found.start));

const CUSTOMER_DUMP = [
    "sqlite> SELECT * FROM klienci LIMIT 3;",
    `1|Jan|Kowalski|${pesel(1985, 1, 1)}|jan.kowalski@firma.pl|+48 600 100 200`,
    `2|Anna|Nowak-Wiśniewska|${pesel(1992, 7, 14, 4562)}|anna.nowak@poczta.pl|601-200-300`,
    `3|Grzegorz|Brzęczyszczykiewicz|${pesel(2003, 11, 30, 7781)}|grzesiek@wp.pl|(22) 123 45 67`,
].join("\n");

describe("detectPersonalData", () => {
    test("a database dump yields every value, by class, well formed", () => {
        const spans = detectPersonalData(CUSTOMER_DUMP, { classes: everything });
        expect(wellFormed(CUSTOMER_DUMP, spans)).toBe(true);
        const counts = new Map<string, number>();
        for (const found of spans) {
            counts.set(found.class, (counts.get(found.class) ?? 0) + 1);
        }
        expect(Object.fromEntries(counts)).toEqual({ "person-name": 6, "national-id": 3, email: 3, phone: 3 });
    });

    test("only the classes asked for are reported", () => {
        const spans = detectPersonalData(CUSTOMER_DUMP, { classes: new Set(["email"]) });
        expect(spans.map((found) => found.value)).toEqual(["jan.kowalski@firma.pl", "anna.nowak@poczta.pl", "grzesiek@wp.pl"]);
        expect(detectPersonalData(CUSTOMER_DUMP, { classes: new Set() })).toEqual([]);
    });

    test("an empty text finds nothing", () => {
        expect(detectPersonalData("", { classes: everything })).toEqual([]);
    });

    test("Polish prose with every kind of value", () => {
        const text = `Pani Anna Kowalska (PESEL ${pesel(1985, 3, 12)}, NIP ${nip("526025099")}) mieszka przy ul. Długiej 5/3, 00-238 Warszawa. Kontakt: anna@kowalska.pl, tel. 600 100 200. Konto: ${iban("PL", "109010140000071219812874")}.`;
        const spans = detectPersonalData(text, { classes: everything });
        expect(spans.map((found) => found.class)).toEqual(["person-name", "national-id", "tax-id", "address", "email", "phone", "bank-account"]);
        expect(wellFormed(text, spans)).toBe(true);
    });
});

describe("the allowlist", () => {
    test("a value on it is never reported, however it is cased or spaced", () => {
        const allow = new Set(["jan kowalski", "anna@kowalska.pl"].map(normalizeAllowed));
        const text = "JAN   KOWALSKI: Jan Kowalski, anna@kowalska.pl, Anna Nowak";
        const values = detectPersonalData(text, { classes: everything, allow }).map((found) => found.value);
        expect(values).toEqual(["Anna Nowak"]);
    });

    test("normalization lowercases, composes and collapses whitespace", () => {
        expect(normalizeAllowed("  Zófia \t KOWALSKA \n")).toBe("zófia kowalska");
        expect(normalizeAllowed("Łukasz")).toBe("łukasz");
    });
});

describe("overlap resolution", () => {
    test("an address keeps the name of its street", () => {
        const text = "ul. Jana Pawła II 12";
        expect(detectPersonalData(text, { classes: everything }).map((found) => `${found.class}:${found.value}`)).toEqual([
            "address:ul. Jana Pawła II 12",
        ]);
    });

    test("an e-mail address keeps the name inside it", () => {
        const text = "Jan.Kowalski@firma.pl";
        expect(detectPersonalData(text, { classes: everything }).map((found) => found.class)).toEqual(["email"]);
    });

    test("the longer span wins, then the more specific class", () => {
        const text = "0123456789012345";
        const longer = mergeSpans([span(0, 11, "national-id", text)], [span(0, 16, "person-name", text)]);
        expect(longer.map((found) => found.class)).toEqual(["person-name"]);
        const tie = mergeSpans([span(2, 8, "person-name", text), span(2, 8, "address", text)], [span(2, 8, "phone", text)]);
        expect(tie.map((found) => found.class)).toEqual(["phone"]);
        const identifiers = mergeSpans([span(0, 6, "address", text)], [span(0, 6, "payment-card", text)]);
        expect(identifiers.map((found) => found.class)).toEqual(["payment-card"]);
    });

    test("a chain of overlaps keeps what does not collide with a winner", () => {
        const text = "abcdefghijklmnopqrstuvwxyz";
        const merged = mergeSpans(
            [span(0, 5, "email", text), span(4, 12, "address", text)],
            [span(11, 14, "person-name", text), span(20, 22, "phone", text)],
        );
        expect(merged.map((found) => [found.start, found.end, found.class])).toEqual([
            [4, 12, "address"],
            [20, 22, "phone"],
        ]);
    });

    // The dictionary does not know Bożydar, so it finds the surname alone; the model finds the whole name, which
    // covers the surname and wins as the longer span.
    test("a model's longer span replaces the detector's shorter one inside it", () => {
        const text = "Spotkałem Bożydara Jana Kowalskiego wczoraj, potem Anna Nowak.";
        const detector = detectPersonalData(text, { classes: everything });
        expect(detector.map((found) => found.value)).toEqual(["Jana Kowalskiego", "Anna Nowak"]);
        const model = [span(10, 35, "person-name", text)];
        expect(mergeSpans(detector, model).map((found) => found.value)).toEqual(["Bożydara Jana Kowalskiego", "Anna Nowak"]);
        expect(mergeSpans([], model)).toEqual(model);
    });
});

describe("speed", () => {
    // A request carries whole transcripts; masking must not be what the turn waits on. The bound is loose on purpose
    // (a busy CI runner is several times slower than an idle one); a backtracking pattern would blow far past it.
    test("a megabyte of mixed text is read well inside the budget", () => {
        const visa = luhn("411111111111111");
        const chunk = [
            CUSTOMER_DUMP,
            "Wczoraj rozmawiałem z Markiem Nowakiem o projekcie. Pani Katarzyna Wiśniewska prosi o kontakt pod numerem 600 100 200.",
            "Yesterday John Smith sent the report to Sarah Johnson; the build at 2024-01-15 12:30:45 took 3.21s.",
            `const user = { firstName: "Jan", card: "${visa}", id: "123e4567-e89b-12d3-a456-426614174000" };`,
            "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 1727786400 fix: handle Adam optimizer state",
            "x".repeat(200),
            "aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgZW5jb2RlZCBkYXRhIEFubmEgS293YWxza2E=",
        ].join("\n");
        const text = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
        const started = performance.now();
        const spans = detectPersonalData(text, { classes: everything });
        const elapsed = performance.now() - started;
        expect(text.length).toBeGreaterThanOrEqual(1_000_000);
        expect(spans.length).toBeGreaterThan(10_000);
        expect(elapsed).toBeLessThan(1500);
    });

    // The inputs a backtracking pattern or a per-word rescan of the line would turn quadratic: one long minified line,
    // a dotted run with no "://", an unbroken digit run, a wall of "@", a row of names with no line breaks.
    test("degenerate inputs stay linear", () => {
        const size = 200_000;
        const inputs = [
            'var a=1;b={name:"Anna",x:"Kowalski"};c=d=>e(f);'.repeat(size / 48),
            "a.".repeat(size / 2),
            "4".repeat(size),
            "1 ".repeat(size / 2),
            `${"x".repeat(60)}@`.repeat(size / 61),
            "Anna ".repeat(size / 5),
            "Jan|".repeat(size / 4),
            "12-345 ".repeat(size / 7),
        ];
        for (const text of inputs) {
            const started = performance.now();
            detectPersonalData(text, { classes: everything });
            expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(1500);
        }
    });
});
