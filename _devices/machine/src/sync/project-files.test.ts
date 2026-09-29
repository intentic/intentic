import { REFERENCE_DIR, STATE_DIR } from "@intentic/constants";
import {
    CHANGES_MAX,
    capped,
    classify,
    type Evidence,
    HELD_CHANGED_HERE,
    HELD_NOT_RUNNING,
    HELD_UNKNOWN,
    ignoreExpression,
    ignoreMatcher,
    type Listed,
    parseListing,
    type ProjectChange,
    selectChanges,
} from "./project-files.js";
import { PROJECT_IGNORES } from "./ssh.js";

// What counts as the sandbox's change in a copy-first project, decided from two listings and the record of where they
// last agreed. The walks themselves are exercised on temp trees in project-transfer.integration.test.ts.

const hash = (letter: string): string => letter.repeat(64);
const file = (size: number, letter: string): Listed => ({ size, hash: hash(letter) });
const listing = (entries: Record<string, Listed>): ReadonlyMap<string, Listed> => new Map(Object.entries(entries));

describe("the project ignore list, as Mutagen reads it", () => {
    const ignored = ignoreMatcher(PROJECT_IGNORES);

    it("leaves out a matched name at any depth, and everything under a matched folder", () => {
        for (const path of [".env", "web/.env", ".env.local", "web/.env.development.local", "node_modules", "a/node_modules/pkg/index.js", ".git", "sub/.git/HEAD", "dist/app.js", "claude.json"]) {
            expect([path, ignored(path)]).toEqual([path, true]);
        }
    });

    // The committed env variants are project content, and `*` never crosses a folder.
    it("keeps everything else, the committed env files and a name the pattern only resembles among them", () => {
        for (const path of [".env.example", ".env.production", "src/.env.ts", "distribution/app.js", `${STATE_DIR}/checks.json`, `${REFERENCE_DIR}/notes.md`, "src/index.ts", ".env.local.bak"]) {
            expect([path, ignored(path)]).toEqual([path, false]);
        }
        expect(ignoreMatcher([".env.*.local"])(".env.a/b.local")).toBe(false);
    });

    it("anchors a pattern that starts with / to the root", () => {
        expect(ignoreMatcher(["/build"])("build/out.js")).toBe(true);
        expect(ignoreMatcher(["/build"])("pkg/build/out.js")).toBe(false);
    });

    it("leaves out Mutagen's own scratch files, which it never syncs", () => {
        expect(ignored("src/.mutagen-temporary-cross-device-rename-1")).toBe(true);
    });

    // Read too narrowly, a pattern would offer an ignored file (a secret among them) for bringing back.
    it("refuses a pattern it cannot match exactly rather than approximating it", () => {
        for (const pattern of ["!keep", "src/*.log", "build/", "a?", "[ab]", "**", "/"]) {
            expect(() => ignoreExpression(pattern)).toThrow("is not one this agent can match exactly");
        }
    });
});

describe("parseListing", () => {
    it("reads NUL-separated entries whole, spaces, quotes and newlines included", () => {
        const odd = "notes/a 'quoted'\nname.md";
        expect([...parseListing(`${odd}\u00002\u0000${hash("a")}\u0000link\u0000-\u0000-\u0000`)]).toEqual([
            [odd, { size: 2, hash: hash("a") }],
            ["link", "other"],
        ]);
        expect([...parseListing("")]).toEqual([]);
    });

    it("refuses a listing cut short, or one it did not write", () => {
        expect(() => parseListing(`a.txt\u00002\u0000${hash("a")}`)).toThrow("the sandbox's file listing ended early");
        expect(() => parseListing("a.txt\u00002\u0000not-a-hash\u0000")).toThrow('is not one this agent wrote (at "a.txt")');
        expect(() => parseListing(`a.txt\u0000-1\u0000${hash("a")}\u0000`)).toThrow("is not one this agent wrote");
    });

    // A backslash is a folder separator on Windows and an ordinary character on Linux: such a name has no one spelling.
    it("leaves out a name no path on this device could spell", () => {
        expect([...parseListing(`a\\b\u00001\u0000${hash("a")}\u0000../up\u00001\u0000${hash("b")}\u0000`)]).toEqual([]);
    });
});

describe("classify", () => {
    // A running session a flush had just taken through a whole cycle, and nothing Mutagen reported.
    const current: Evidence = { current: true, unchangedHere: new Map() };

    it("with no record, offers what the sandbox added, holds what differs, and never offers a file only this device holds", () => {
        const local = listing({ "same.ts": file(1, "a"), "edited.ts": file(1, "a"), "made-here.ts": file(1, "c") });
        const remote = listing({ "same.ts": file(1, "a"), "edited.ts": file(2, "b"), "new.ts": file(3, "d") });
        expect(classify(local, remote, new Map(), current)).toEqual({
            changes: [
                { path: "edited.ts", kind: "modified", size: 2, held: HELD_UNKNOWN },
                { path: "new.ts", kind: "added", size: 3 },
            ],
            agreed: new Map([["same.ts", hash("a")]]),
        });
    });

    // The record is what tells whose change a difference is, and a copy here that moved away from it is never written over.
    it("puts each difference down to the side that moved away from the last agreement, and holds one both moved", () => {
        const agreed = new Map([
            ["changed-there.ts", hash("a")],
            ["changed-here.ts", hash("a")],
            ["changed-both.ts", hash("a")],
            ["deleted-there.ts", hash("a")],
            ["deleted-here.ts", hash("a")],
            ["deleted-here-changed-there.ts", hash("a")],
            ["deleted-there-changed-here.ts", hash("a")],
        ]);
        const local = listing({
            "changed-there.ts": file(1, "a"),
            "changed-here.ts": file(1, "b"),
            "changed-both.ts": file(1, "b"),
            "deleted-there.ts": file(1, "a"),
            "deleted-there-changed-here.ts": file(1, "b"),
        });
        const remote = listing({
            "changed-there.ts": file(1, "b"),
            "changed-here.ts": file(1, "a"),
            "changed-both.ts": file(1, "c"),
            "deleted-here.ts": file(1, "a"),
            "deleted-here-changed-there.ts": file(1, "c"),
        });
        expect(classify(local, remote, agreed, current).changes).toEqual([
            { path: "changed-both.ts", kind: "modified", size: 1, held: HELD_CHANGED_HERE },
            { path: "changed-there.ts", kind: "modified", size: 1 },
            { path: "deleted-here-changed-there.ts", kind: "added", size: 1 },
            { path: "deleted-there.ts", kind: "deleted" },
        ]);
    });

    // THE REVIEWED CASE: the record says v1, the owner's v2 reached the sandbox, the sync was paused, and the owner wrote
    // v3. The sandbox's v2 differs from the record, but so does this device's v3: bringing v2 back would lose v3.
    it("holds a path whose record is stale rather than writing the owner's older copy over a newer one", () => {
        const stale = new Map([["notes.md", hash("1")]]);
        const local = listing({ "notes.md": file(2, "3") });
        const remote = listing({ "notes.md": file(2, "2") });
        expect(classify(local, remote, stale, current).changes).toEqual([{ path: "notes.md", kind: "modified", size: 2, held: HELD_CHANGED_HERE }]);
        expect(classify(local, remote, stale, { current: false, unchangedHere: new Map() }).changes).toEqual([
            { path: "notes.md", kind: "modified", size: 2, held: HELD_NOT_RUNNING },
        ]);
    });

    // Without a cycle that just carried this device's edits over, a difference cannot be put down to either side.
    it("holds every modified path when the session was not running a cycle, record or not", () => {
        const agreed = new Map([["a.ts", hash("a")]]);
        expect(classify(listing({ "a.ts": file(1, "a") }), listing({ "a.ts": file(1, "b") }), agreed, { current: false, unchangedHere: new Map() }).changes).toEqual([
            { path: "a.ts", kind: "modified", size: 1, held: HELD_NOT_RUNNING },
        ]);
    });

    // Mutagen's record of the last agreement is fresh every cycle, where the listing's is only as fresh as the last listing.
    it("takes Mutagen's word for the files it reported, over the listing record either way", () => {
        const agreed = new Map([["said-unchanged.ts", hash("x")]]);
        const local = listing({ "said-unchanged.ts": file(1, "a"), "said-changed.ts": file(1, "a"), "unreported.ts": file(1, "a") });
        const remote = listing({ "said-unchanged.ts": file(1, "b"), "said-changed.ts": file(1, "b"), "unreported.ts": file(1, "b") });
        const said: Evidence = {
            current: true,
            unchangedHere: new Map([
                ["said-unchanged.ts", true],
                ["said-changed.ts", false],
            ]),
        };
        expect(classify(local, remote, agreed, said).changes).toEqual([
            { path: "said-changed.ts", kind: "modified", size: 1, held: HELD_CHANGED_HERE },
            { path: "said-unchanged.ts", kind: "modified", size: 1 },
            { path: "unreported.ts", kind: "modified", size: 1, held: HELD_UNKNOWN },
        ]);
    });

    it("records agreement where the copies are equal, keeps the old one where they differ, and forgets a path both dropped", () => {
        const agreed = new Map([
            ["differs.ts", hash("a")],
            ["gone.ts", hash("a")],
            ["now-equal.ts", hash("a")],
        ]);
        const local = listing({ "differs.ts": file(1, "b"), "now-equal.ts": file(1, "c") });
        const remote = listing({ "differs.ts": file(1, "c"), "now-equal.ts": file(1, "c") });
        expect(classify(local, remote, agreed, current).agreed).toEqual(
            new Map([
                ["differs.ts", hash("a")],
                ["now-equal.ts", hash("c")],
            ]),
        );
    });

    // A link that replaced a file in the sandbox must not read as that file's deletion, and is never carried back.
    it("never compares anything that is not a regular file on either side", () => {
        const agreed = new Map([["was-a-file", hash("a")]]);
        expect(classify(listing({ "was-a-file": file(1, "a"), here: "other" }), listing({ "was-a-file": "other", here: file(1, "b") }), agreed, current)).toEqual({
            changes: [],
            agreed: new Map(),
        });
    });

    // Size first: a local file whose size already differs, and that no record needs, is not read, and still differs.
    it("counts a file of another size as changed without its hash", () => {
        expect(classify(listing({ "a.ts": { size: 1 } }), listing({ "a.ts": file(2, "b") }), new Map(), current).changes).toEqual([
            { path: "a.ts", kind: "modified", size: 2, held: HELD_UNKNOWN },
        ]);
    });
});

describe("capped", () => {
    const changes: ProjectChange[] = Array.from({ length: CHANGES_MAX + 1 }, (_, at) => ({ path: `f-${String(at).padStart(5, "0")}`, kind: "added" }));

    it("lists the first 5,000 and says there were more", () => {
        expect(CHANGES_MAX).toBe(5000);
        const shown = capped(changes);
        expect([shown.changes.length, shown.changes.at(-1)?.path, shown.truncated]).toEqual([5000, "f-04999", true]);
        expect(capped(changes.slice(0, CHANGES_MAX)).truncated).toBe(false);
    });
});

describe("selectChanges", () => {
    const changes: ProjectChange[] = [
        { path: "src/a.ts", kind: "added" },
        { path: "src/deep/b.ts", kind: "modified" },
        { path: "srcs/c.ts", kind: "deleted" },
    ];

    it("takes every change with no path given, a file by its path, and a folder with everything under it", () => {
        expect(selectChanges(changes, [])).toEqual({ selected: changes, unmatched: [] });
        expect(selectChanges(changes, ["src/", "srcs/c.ts"])).toEqual({ selected: changes, unmatched: [] });
        expect(selectChanges(changes, ["src/deep"]).selected).toEqual([{ path: "src/deep/b.ts", kind: "modified" }]);
    });

    it("names a path that matches no change, a folder's namesake prefix included", () => {
        expect(selectChanges(changes, ["sr", "other.ts"])).toEqual({ selected: [], unmatched: ["sr", "other.ts"] });
    });
});
