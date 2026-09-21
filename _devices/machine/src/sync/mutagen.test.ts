import { clearableOnDevice } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    CONFLICT_PATHS_MAX,
    conflictsFrom,
    forwardSessionName,
    parseForwardNames,
    parseForwardPorts,
    parseOrphanForwardNames,
    parseOrphanSyncNames,
    sessionName,
} from "./mutagen.js";

// What the per-tick reconcile cannot learn from its own baseline: which ports this device is actually holding.
describe("parseForwardPorts", () => {
    it("reads one sandbox's bound ports off its session names, ignoring another's", () => {
        const listed = [forwardSessionName("sandbox-a", 5173), forwardSessionName("sandbox-a", 38_043), forwardSessionName("sandbox-b", 6480)].join(" ");
        expect(parseForwardPorts(listed, "sandbox-a")).toEqual([5173, 38_043]);
    });

    it("answers nothing for a sandbox holding none", () => {
        expect(parseForwardPorts(forwardSessionName("sandbox-b", 6480), "sandbox-a")).toEqual([]);
    });
});

// The line between retiring this agent's forwards and terminating the user's own Mutagen sessions. Names are
// whitespace-free by construction, which is what makes splitting on whitespace safe.
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

    // Tearing down one pairing must leave every other sandbox's forwards holding their ports.
    it("narrows to one sandbox when asked", () => {
        const listed = `${forwardSessionName("sandbox-a.example.dev", 5173)} ${forwardSessionName("sandbox-b.example.dev", 5173)} ${forwardSessionName("sandbox-a.example.dev", 6480)}`;
        expect(parseForwardNames(listed, "sandbox-a.example.dev")).toEqual([
            forwardSessionName("sandbox-a.example.dev", 5173),
            forwardSessionName("sandbox-a.example.dev", 6480),
        ]);
    });

    // A prefix test would sweep sandbox-a-b when tearing down sandbox-a; the port is parsed off the end instead.
    it("does not mistake one sandbox id for the prefix of another", () => {
        const listed = `${forwardSessionName("sandbox-a", 5173)} ${forwardSessionName("sandbox-a-b", 5173)}`;
        expect(parseForwardNames(listed, "sandbox-a")).toEqual([forwardSessionName("sandbox-a", 5173)]);
        expect(parseForwardNames(listed, "sandbox-a-b")).toEqual([forwardSessionName("sandbox-a-b", 5173)]);
    });
});

// Mutagen keeps a forward's listener bound after its sandbox is gone; a session no pairing can name is a port
// nothing will ever mirror again.
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

// A file-sync session is retired only because nothing claims it, never because another pairing arrived.
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

// Protobuf JSON via Go's encoding/json: an absent field means absent, and which of `old`/`new` is present says
// which way the change went.
describe("conflictsFrom", () => {
    // The kind as Mutagen 0.18.1 actually prints it in `sync list --template {{json .}}`: the enum's NAME, not its
    // number. Read off a live wedged session, which is also where the `untracked` cases below come from.
    const entry = { kind: "file" };
    const directory = { kind: "directory", contents: null };
    const untracked = { kind: "untracked" };

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
            { path: "notes.md", local: "modified", sandbox: "deleted", nature: "both-edited" },
            { path: "new.ts", local: "created", sandbox: "created", nature: "both-edited" },
        ]);
    });

    // A conflict rooted at a directory describes the nearest change under it, not nothing.
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
        expect(read?.paths).toEqual([{ path: "src", local: "modified", sandbox: "deleted", nature: "both-edited" }]);
    });

    // An empty root is the synced folder itself, Mutagen's report for a root-level collision; dropping it would lose
    // the loudest conflict there is.
    it("keeps a root-level conflict, which has no path to name", () => {
        expect(conflictsFrom({ conflicts: [{ root: "" }] })?.paths).toEqual([{ path: "", nature: "both-edited" }]);
    });

    it("says nothing about a side whose change kind Mutagen did not report", () => {
        // A side Mutagen said nothing about falls to `both-edited`: nothing may be cleared on the strength of silence.
        expect(conflictsFrom({ conflicts: [{ root: "a.ts", alphaChanges: [{ path: "a.ts" }] }] })?.paths).toEqual([
            { path: "a.ts", nature: "both-edited" },
        ]);
    });

    // THE CONFLICT THIS PRODUCT ACTUALLY PRODUCES, copied from a wedged session on a dogfooding machine: an agent
    // moved six package directories in the sandbox, and each one stood because this device still had build output in
    // it. Read as a creation, it says the user made a `node_modules` and must now reconcile two copies of it.
    it("reads ignored content as build output left behind, not as something somebody created", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "intentic/_extensions/acceptance",
                    alphaChanges: [
                        { path: "intentic/_extensions/acceptance/.cache", old: null, new: untracked },
                        { path: "intentic/_extensions/acceptance/.turbo", old: null, new: untracked },
                        { path: "intentic/_extensions/acceptance/node_modules", old: null, new: untracked },
                    ],
                    betaChanges: [{ path: "intentic/_extensions/acceptance", old: directory, new: null }],
                },
            ],
        });
        expect(read?.paths).toEqual([
            { path: "intentic/_extensions/acceptance", local: "untracked", sandbox: "deleted", nature: "derived-leftover" },
        ]);
    });

    // The asymmetry that keeps the heal safe: `untracked` licenses deleting a directory unasked, so one real file
    // among the ignored ones must take the whole side out of that class.
    it("refuses to call a side build output when one real file sits among it", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "pkg",
                    alphaChanges: [
                        { path: "pkg/node_modules", old: null, new: untracked },
                        { path: "pkg/notes.md", old: null, new: entry },
                    ],
                    betaChanges: [{ path: "pkg", old: directory, new: null }],
                },
            ],
        });
        expect(read?.paths).toEqual([{ path: "pkg", local: "created", sandbox: "deleted", nature: "both-edited" }]);
    });

    // MEASURED ON A DOGFOODING MACHINE: four standalone extension repositories the sandbox deleted stood on rog for
    // days, each held open by its own `.git`. Mutagen scans a repository exactly as it scans `node_modules` — both are
    // ignored — so the side read as build output, the card offered a one-click clear, and its sentence said nothing of
    // the reader's was in there. A clone whose remote has gone is the one thing in that directory with no other copy.
    it("refuses to call a git repository build output, however the session ignores it", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "extensions/homelab",
                    alphaChanges: [{ path: "extensions/homelab/.git", old: null, new: untracked }],
                    betaChanges: [{ path: "extensions/homelab", old: directory, new: null }],
                },
            ],
        });
        expect(read?.paths).toEqual([{ path: "extensions/homelab", local: "created", sandbox: "deleted", nature: "both-edited" }]);
        expect(read?.paths.map((conflict) => clearableOnDevice(conflict))).toEqual([false]);
    });

    // The same standoff the other way round: the sandbox holds the residue, this device made the deletion. Named as
    // derived so a reader is told what it is — but `clearableOnDevice` is what decides anything is removed, and this
    // is not it.
    it("classifies residue on the sandbox's side too, without making it this device's to clear", () => {
        const read = conflictsFrom({
            conflicts: [
                {
                    root: "pkg",
                    alphaChanges: [{ path: "pkg", old: directory, new: null }],
                    betaChanges: [{ path: "pkg/dist", old: null, new: untracked }],
                },
            ],
        });
        expect(read?.paths).toEqual([{ path: "pkg", local: "deleted", sandbox: "untracked", nature: "derived-leftover" }]);
        expect(read?.paths.map((conflict) => clearableOnDevice(conflict))).toEqual([false]);
    });

    // Re-read every few seconds by every device card, so the path list is capped here too; the count never is.
    it("carries at most CONFLICT_PATHS_MAX of them, and still counts them all", () => {
        const conflicts = Array.from({ length: CONFLICT_PATHS_MAX + 12 }, (_, at) => ({ root: `f-${at}` }));
        const read = conflictsFrom({ conflicts });
        expect(read?.paths).toHaveLength(CONFLICT_PATHS_MAX);
        expect(read?.count).toBe(CONFLICT_PATHS_MAX + 12);
    });
});
