import { describe, expect, it } from "vitest";
import { forwardSessionName, parseForwardNames, parseOrphanForwardNames, parseOrphanSyncNames, sessionName } from "./mutagen.js";

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

    // Tearing down ONE pairing must leave every other paired sandbox's forwards holding their ports — the whole
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

/* A file-sync session is retired because NOTHING claims it any more — never because another pairing arrived.
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
