import { describe, expect, it } from "vitest";
import {
    CONFLICT_PATHS_MAX,
    conflictsFrom,
    forwardSessionName,
    parseForwardNames,
    parseOrphanForwardNames,
    parseOrphanSyncNames,
    sessionName,
} from "./mutagen.js";

// What `forward list` hands back decides what gets terminated, so this filter is the line between "retire the
// forwards this agent left behind" and "terminate the user's own Mutagen sessions". Names are whitespace-free
// by construction (a sanitized sandbox id plus a port), which is what makes splitting on whitespace safe.
describe("parseForwardNames", () => {
    it("keeps every session under this agent's prefix and nothing else", () => {
        expect(parseForwardNames("intentic-fwd-sandbox-a-5173 someone-elses-forward intentic-fwd-sandbox-b-6480\n")).toEqual([
            "intentic-fwd-sandbox-a-5173",
            "intentic-fwd-sandbox-b-6480",
        ]);
    });

    it("reads an empty list as nothing to retire", () => {
        expect(parseForwardNames("")).toEqual([]);
        expect(parseForwardNames("  \n ")).toEqual([]);
    });

    it("matches what forwardSessionName produces, for any sandbox", () => {
        const names = [forwardSessionName("sandbox-old.example.dev", 5173), forwardSessionName("sandbox-new.example.dev", 6480)];
        expect(parseForwardNames(`${names.join(" ")} mutagen-something-else`)).toEqual(names);
    });

    // Tearing down ONE pairing must leave every other paired sandbox's forwards holding their ports: the whole
    // reason a machine can now sync a fleet.
    it("narrows to one sandbox when asked", () => {
        const listed = `${forwardSessionName("sandbox-a.example.dev", 5173)} ${forwardSessionName("sandbox-b.example.dev", 5173)} ${forwardSessionName("sandbox-a.example.dev", 6480)}`;
        expect(parseForwardNames(listed, "sandbox-a.example.dev")).toEqual([
            forwardSessionName("sandbox-a.example.dev", 5173),
            forwardSessionName("sandbox-a.example.dev", 6480),
        ]);
    });

    // A prefix test would sweep sandbox-a-b's forwards while tearing down sandbox-a's, because the first name is
    // a prefix of the second. The port is parsed off the end instead.
    it("does not mistake one sandbox id for the prefix of another", () => {
        const listed = `${forwardSessionName("sandbox-a", 5173)} ${forwardSessionName("sandbox-a-b", 5173)}`;
        expect(parseForwardNames(listed, "sandbox-a")).toEqual([forwardSessionName("sandbox-a", 5173)]);
        expect(parseForwardNames(listed, "sandbox-a-b")).toEqual([forwardSessionName("sandbox-a-b", 5173)]);
    });
});

// Mutagen keeps a forward's localhost listener bound after its sandbox is gone, so a session no pairing can name
// is a port nothing will ever mirror again.
describe("parseOrphanForwardNames", () => {
    const held = forwardSessionName("sandbox-held.example.dev", 5173);
    const gone = forwardSessionName("sandbox-gone.example.dev", 6480);

    it("keeps the forwards of every sandbox still paired and reports the rest", () => {
        expect(parseOrphanForwardNames(`${held} ${gone}`, ["sandbox-held.example.dev"])).toEqual([gone]);
    });

    it("reports everything of ours when nothing is paired any more", () => {
        expect(parseOrphanForwardNames(`${held} ${gone}`, [])).toEqual([held, gone]);
    });

    it("never touches a forward the user made themselves", () => {
        expect(parseOrphanForwardNames("my-own-forward mutagen-something", [])).toEqual([]);
    });
});

/* A file-sync session is retired because NOTHING claims it any more: never because another pairing arrived.
 * Retiring on arrival is precisely what evicted a live sandbox: pairing a second one terminated the first's
 * session, so the folder the user was working in silently stopped syncing while `status` still called it healthy. */
describe("parseOrphanSyncNames", () => {
    const first = sessionName("sandbox-first.example.dev");
    const second = sessionName("sandbox-second.example.dev");

    it("keeps every session a live pairing names", () => {
        expect(parseOrphanSyncNames(`${first} ${second}`, [first, second])).toEqual([]);
    });

    it("retires only the sessions no pairing names", () => {
        const abandoned = sessionName("sandbox-abandoned.example.dev");
        expect(parseOrphanSyncNames(`${first} ${abandoned} ${second}`, [first, second])).toEqual([abandoned]);
    });

    it("never touches a session the user made themselves", () => {
        expect(parseOrphanSyncNames(`my-own-project-sync ${first} work-laptop`, [first])).toEqual([]);
    });

    it("has nothing to retire on a first pairing", () => {
        expect(parseOrphanSyncNames("", [first])).toEqual([]);
        expect(parseOrphanSyncNames(first, [first])).toEqual([]);
    });
});

/* WHAT IS ACTUALLY STUCK, off Mutagen's own state.
 *
 * Every assertion here is a way the device card lied. It said "10 conflicts" and named no file, and the number
 * itself was the length of a list Mutagen truncates, so the badge on a session holding forty said ten forever.
 * The shape is protobuf JSON through Go's encoding/json: absent means absent, and `old`/`new` missing is the
 * whole message about which way the change went. */
describe("conflictsFrom", () => {
    const entry = { kind: 1 };

    it("says nothing at all when Mutagen reported no conflicts", () => {
        expect(conflictsFrom({})).toBeUndefined();
        expect(conflictsFrom({ conflicts: [] })).toBeUndefined();
    });

    it("counts what Mutagen left OUT of the list, which is why a bad session used to read as ten", () => {
        const conflicts = Array.from({ length: 10 }, (_, at) => ({ root: `src/file-${at}.ts` }));
        const read = conflictsFrom({ conflicts, excludedConflicts: 30 });
        expect(read?.count).toBe(40);
        // The paths are what it described; the count is the whole truth about how many there are.
        expect(read?.paths).toHaveLength(10);
    });

    it("reads each side's change kind from which half of it exists", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "notes.md",
                    alphaChanges: [{ path: "notes.md", old: entry, new: entry }],
                    betaChanges: [{ path: "notes.md", old: entry }],
                },
                { root: "new.ts", alphaChanges: [{ path: "new.ts", new: entry }], betaChanges: [{ path: "new.ts", new: entry }] },
            ],
        });
        expect(read?.paths).toEqual([
            { path: "notes.md", local: "modified", sandbox: "deleted" },
            { path: "new.ts", local: "created", sandbox: "created" },
        ]);
    });

    // A conflict rooted at a directory carries the changes UNDER it, so the word describes the nearest change
    // there is rather than nothing at all: the path is the finding either way.
    it("takes the change that is about the conflicted path, and falls back to the first one", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "src",
                    alphaChanges: [{ path: "src/late.ts", new: entry }, { path: "src", old: entry, new: entry }],
                    betaChanges: [{ path: "src/other.ts", old: entry }],
                },
            ],
        });
        expect(read?.paths).toEqual([{ path: "src", local: "modified", sandbox: "deleted" }]);
    });

    /* An empty root is the SYNCED FOLDER itself, which Mutagen reports for a root-level collision. It travels as
     * "" and is said in words by whatever prints it: a reader that dropped it would lose the loudest conflict
     * there is. */
    it("keeps a root-level conflict, which has no path to name", () => {
        expect(conflictsFrom({ conflicts: [{ root: "" }] })?.paths).toEqual([{ path: "" }]);
    });

    it("says nothing about a side whose change kind Mutagen did not report", () => {
        expect(conflictsFrom({ conflicts: [{ root: "a.ts", alphaChanges: [{ path: "a.ts" }] }] })?.paths).toEqual([{ path: "a.ts" }]);
    });

    // The report is re-read every few seconds by every device card, so the list it carries is capped here as
    // well as by Mutagen. The COUNT is never capped.
    it("carries at most CONFLICT_PATHS_MAX of them, and still counts them all", () => {
        const conflicts = Array.from({ length: CONFLICT_PATHS_MAX + 12 }, (_, at) => ({ root: `f-${at}` }));
        const read = conflictsFrom({ conflicts });
        expect(read?.paths).toHaveLength(CONFLICT_PATHS_MAX);
        expect(read?.count).toBe(CONFLICT_PATHS_MAX + 12);
    });
});
