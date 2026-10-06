import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnownMatcher } from "../known-matcher.js";
import { filePrivacyVault } from "../privacy-vault.js";
import { pesel } from "../detect/tests/ids.testing.js";

// The vault is what makes a token mean one value forever: a provider holds old transcripts, so an index handed to a
// second value would restore somebody else's data into a command. These pin the properties that guarantee it.

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "privacy-vault-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("tokens", () => {
    test("the same value is the same token, and a new value the next index of its kind", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.load();
        expect(vault.tokenFor("Jan Kowalski", "person-name")).toBe("⟦PERSON_1⟧");
        expect(vault.tokenFor("Anna Nowak", "person-name")).toBe("⟦PERSON_2⟧");
        expect(vault.tokenFor("Jan Kowalski", "person-name")).toBe("⟦PERSON_1⟧");
        expect(vault.tokenFor("85010112345", "national-id")).toBe("⟦NATIONAL_ID_1⟧");
        expect(vault.resolve("PERSON", "2")).toBe("Anna Nowak");
        expect(vault.resolve("PERSON", "9")).toBeUndefined();
    });

    // Only the number the vault wrote names its value: a model that pads or re-spells it has made up a token, and a made-up
    // token is left as it came rather than read as whichever value happens to share its digits.
    test("a token number written any other way than the vault wrote it resolves to nothing", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.load();
        const value = ["Ada", "Nowak"].join(" ");
        vault.tokenFor(value, "person-name");
        vault.tokenFor(`${value}a`, "person-name");
        expect(vault.resolve("PERSON", "1")).toBe(value);
        for (const spelled of ["01", "0001", "00", "0"]) {
            expect(vault.resolve("PERSON", spelled)).toBeUndefined();
        }
    });

    test("a committed token survives a restart, and a restart never hands its index out again", async () => {
        const path = join(dir, "vault.json");
        const first = filePrivacyVault(path);
        await first.load();
        first.tokenFor("Jan Kowalski", "person-name");
        await first.commit();
        const second = filePrivacyVault(path);
        await second.load();
        expect(second.resolve("PERSON", "1")).toBe("Jan Kowalski");
        expect(second.tokenFor("Ewa Wiśniewska", "person-name")).toBe("⟦PERSON_2⟧");
    });

    test("counters that lag their entries (an older or hand-edited file) still never repeat an index", async () => {
        const path = join(dir, "vault.json");
        await writeFile(path, JSON.stringify({ next: {}, entries: [{ value: "Jan Kowalski", class: "person-name", index: 7 }] }));
        const vault = filePrivacyVault(path);
        await vault.load();
        expect(vault.tokenFor("Anna Nowak", "person-name")).toBe("⟦PERSON_8⟧");
    });

    test("a vault that exists but cannot be read refuses to load rather than starting empty", async () => {
        const path = join(dir, "vault.json");
        await writeFile(path, "{ not json");
        const vault = filePrivacyVault(path);
        await expect(vault.load()).rejects.toThrow(/could not be read/u);
    });

    test("the file is written only on commit, and with owner-only permissions", async () => {
        const path = join(dir, "vault.json");
        const vault = filePrivacyVault(path);
        await vault.load();
        vault.tokenFor("Jan Kowalski", "person-name");
        await expect(readFile(path, "utf8")).rejects.toThrow();
        await vault.commit();
        expect(JSON.parse(await readFile(path, "utf8")).entries).toHaveLength(1);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
});

describe("taught datasets", () => {
    test("taught values are matched, counted per source, and forgetting stops matching but keeps resolving", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"), () => new Date("2026-10-01T10:00:00Z"));
        const taught = await vault.learn("clients.csv (name)", [
            { value: "Jan Kowalski", class: "person-name" },
            { value: "Anna Nowak", class: "person-name" },
            { value: "ab", class: "person-name" },
        ]);
        expect(taught).toEqual({ added: 2, known: 2 });
        expect(await vault.sources()).toEqual([{ source: "clients.csv (name)", count: 2, at: "2026-10-01T10:00:00.000Z" }]);
        expect(
            vault
                .matcher()
                .find("Klient: Anna Nowak, tel.")
                .map((hit) => hit.payload.token),
        ).toEqual(["⟦PERSON_2⟧"]);
        expect(await vault.forget("clients.csv (name)")).toBe(2);
        expect(vault.matcher().find("Klient: Anna Nowak")).toEqual([]);
        expect(vault.resolve("PERSON", "2")).toBe("Anna Nowak");
    });

    test("a value Python wrote with its non-ASCII letters escaped is matched as the same token", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.learn("crm", [{ value: "Łukasz Żak", class: "person-name" }]);
        const hits = vault.matcher().find('{"name": "\\u0141ukasz \\u017bak"}');
        expect(hits.map((hit) => hit.payload.token)).toEqual(["⟦PERSON_1⟧"]);
    });
});

describe("the exact matcher", () => {
    const matcher = createKnownMatcher([
        { value: "Jan Kowalski", payload: "full" },
        { value: "Jan", payload: "first" },
        { value: "+48 600 100 200", payload: "phone" },
        { value: "85010112345", payload: "pesel" },
    ]);

    test("the longest value at a place wins, whole words only", () => {
        expect(matcher.find("Jan Kowalski i Jan").map((hit) => hit.payload)).toEqual(["full", "first"]);
        expect(matcher.find("Janusz i Jana")).toEqual([]);
    });

    test("a value starting with punctuation is found from its first word", () => {
        const [hit] = matcher.find("dzwoń: +48 600 100 200 wieczorem");
        expect(hit?.payload).toBe("phone");
        expect("dzwoń: +48 600 100 200 wieczorem".slice(hit?.start, hit?.end)).toBe("+48 600 100 200");
    });

    // Raw JSON text writes a line break as `\n`, a tab as `\t`: the letter belongs to the escape, so a known value right
    // after one stands on a word boundary.
    test("a known value right after a JSON escape is found", () => {
        const number = pesel(1985, 3, 14, 4562);
        const known = createKnownMatcher([{ value: number, payload: "pesel" }]);
        for (const text of [`{"o":"x\\n${number}"}`, `a\\t${number}`, `\\r${number}`]) {
            expect(known.find(text).map((hit) => text.slice(hit.start, hit.end)), text).toEqual([number]);
        }
        expect(known.find(`x${number}`)).toEqual([]);
    });

    test("a number inside a longer number is not the number", () => {
        expect(matcher.find("id 1850101123456")).toEqual([]);
        expect(matcher.find("PESEL: 85010112345.").map((hit) => hit.payload)).toEqual(["pesel"]);
    });
});

// A value is the same value however it is cased or spaced: a taught member number written in lower case or without
// its hyphens, a name in capitals, split by a line break or joined into a file name. Each is found, and a detector that
// finds one of those spellings gets the token the value already has rather than a second one.
describe("spellings", () => {
    const tokensIn = (vault: ReturnType<typeof filePrivacyVault>, text: string): string[] =>
        vault
            .matcher()
            .find(text)
            .map((hit) => `${text.slice(hit.start, hit.end)}=${hit.payload.token}`);

    test("a taught number is found in any case and with its separators anywhere or nowhere, and only as a whole word", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.learn("crm", [{ value: "ACME-0042-XK", class: "identity-document" }]);
        const token = "⟦ID_DOCUMENT_1⟧";
        for (const spelled of ["ACME-0042-XK", "acme-0042-xk", "ACME0042XK", "ACME 0042 XK", "Acme_0042_xk"]) {
            expect(tokensIn(vault, `member ${spelled} renewed`), spelled).toEqual([`${spelled}=${token}`]);
        }
        for (const other of ["XACME-0042-XK", "ACME-0042-XKA", "ACME-0042-X"]) {
            expect(tokensIn(vault, `member ${other} renewed`), other).toEqual([]);
        }
    });

    test("a known full name keeps its one token however it is re-cased or re-spaced", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.load();
        const name = ["Jan", "Kowalski"].join(" ");
        const token = vault.tokenFor(name, "person-name");
        for (const spelled of ["JAN KOWALSKI", "jan kowalski", "Jan  Kowalski", "Jan\nKowalski", "jan_kowalski", "jan-kowalski", "JanKowalski"]) {
            expect(vault.tokenFor(spelled, "person-name"), spelled).toBe(token);
            expect(tokensIn(vault, `plik ${spelled}.pdf`), spelled).toEqual([`${spelled}=${token}`]);
        }
        // What the token reads back as is the spelling it was first given for.
        expect(vault.resolve("PERSON", "1")).toBe(name);
    });

    test("one plain word is found only as written, and an address in any case but with its own dots", async () => {
        const vault = filePrivacyVault(join(dir, "vault.json"));
        await vault.learn("crm", [
            { value: "Mark", class: "person-name" },
            { value: "Jan.Nowak@Firma.PL", class: "email" },
        ]);
        expect(tokensIn(vault, "Mark wrote")).toHaveLength(1);
        expect(tokensIn(vault, "mark the line")).toEqual([]);
        expect(tokensIn(vault, "to jan.nowak@firma.pl")).toHaveLength(1);
        expect(tokensIn(vault, "to jannowak@firma.pl")).toEqual([]);
        expect(vault.tokenFor("jan.nowak@firma.pl", "email")).toBe("⟦EMAIL_1⟧");
    });

    test("two spellings an older vault holds apart both keep resolving, and a commit keeps both", async () => {
        const path = join(dir, "vault.json");
        await writeFile(
            path,
            JSON.stringify({
                next: { PERSON: 3 },
                entries: [
                    { value: "Jan Kowalski", class: "person-name", index: 1 },
                    { value: "JAN KOWALSKI", class: "person-name", index: 2 },
                ],
            }),
        );
        const vault = filePrivacyVault(path);
        await vault.load();
        expect(vault.tokenFor("jan kowalski", "person-name")).toBe("⟦PERSON_1⟧");
        vault.tokenFor("Anna Nowak", "person-name");
        await vault.commit();
        const again = filePrivacyVault(path);
        await again.load();
        expect(again.resolve("PERSON", "1")).toBe("Jan Kowalski");
        expect(again.resolve("PERSON", "2")).toBe("JAN KOWALSKI");
        expect((await again.counts()).tokens).toBe(3);
    });
});
