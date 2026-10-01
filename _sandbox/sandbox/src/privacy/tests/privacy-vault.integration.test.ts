import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnownMatcher } from "../known-matcher.js";
import { filePrivacyVault } from "../privacy-vault.js";

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

    test("a number inside a longer number is not the number", () => {
        expect(matcher.find("id 1850101123456")).toEqual([]);
        expect(matcher.find("PESEL: 85010112345.").map((hit) => hit.payload)).toEqual(["pesel"]);
    });
});
