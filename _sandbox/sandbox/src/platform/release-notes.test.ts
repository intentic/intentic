import { afterEach, expect, test, vi } from "vitest";
import { isDevBuild } from "../version.js";
import { breakingNotes, parseBreakingNotes, parseReleaseNotes, refreshReleaseNotes, startReleaseNotesCheck, updateNotes } from "./release-notes.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

// The body publish-github.sh writes: the user-facing section first, then the commit-subject grouping under it.
const RELEASE_BODY = [
    "## What's new",
    "",
    "- Your models stay in the order you set them.",
    "- The commit box keeps a full message.",
    "",
    "### Features",
    "",
    "- ordered model picker",
    "- a background loader for the whole app",
    "",
    "### Other",
    "",
    "- audit rail icons",
].join("\n");

const releasesResponse = (releases: unknown): Response => new Response(JSON.stringify(releases), { status: 200 });

test("reads the user-facing section and stops at the commit list under it", () => {
    // The three "### Features" bullets are subjects, not notes: taking them would put "audit rail icons" in
    // front of a user, which is the whole thing this section exists to keep out.
    expect(parseReleaseNotes(RELEASE_BODY)).toEqual(["Your models stay in the order you set them.", "The commit box keeps a full message."]);
});

test("a release with nothing a user would notice yields no notes", () => {
    expect(parseReleaseNotes("### Features\n\n- ordered model picker\n")).toEqual([]);
    expect(parseReleaseNotes("")).toEqual([]);
});

// The body publish-github.sh writes when a commit declared a break: its own section, above What's new.
const BREAKING_BODY = ["## Breaking changes", "", "- The old picker layout is gone — use the new list.", "", ...RELEASE_BODY.split("\n")].join("\n");

test("reads the breaking section apart from the notes", () => {
    expect(parseBreakingNotes(BREAKING_BODY)).toEqual(["The old picker layout is gone — use the new list."]);
    // Each parser sees only its own section: a break is not a note, and a note is not a warning.
    expect(parseReleaseNotes(BREAKING_BODY)).toEqual(["Your models stay in the order you set them.", "The commit box keeps a full message."]);
    expect(parseBreakingNotes(RELEASE_BODY)).toEqual([]);
});

test("collects every breaking sentence in the gap, and a release that only breaks still counts", async () => {
    vi.stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## Breaking changes\n\n- The export command is gone.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- Middle thing.\n" },
        ]),
    );
    await refreshReleaseNotes();
    // v1.188.0 carries no What's new at all: it must still be cached, or the warning never reaches the card.
    expect(breakingNotes("1.186.0")).toEqual(["The export command is gone."]);
    expect(updateNotes("1.186.0")).toEqual(["Middle thing."]);
    // Past the break, nothing to warn about.
    expect(breakingNotes("1.188.0")).toEqual([]);
});

test("collects the notes for every release newer than this sandbox, and none of the older ones", async () => {
    vi.stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## What's new\n\n- Newest thing.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- Middle thing.\n" },
            { tag_name: "v1.186.0", body: "## What's new\n\n- Already installed.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["Newest thing.", "Middle thing."]);
    // Nothing newer than the newest: the card shows no notes rather than repeating the last release's.
    expect(updateNotes("1.188.0")).toEqual([]);
});

test("says one change once, however many releases carried it", async () => {
    // Work that lands in pieces repeats its sentence across releases; three copies on one card reads as a bug.
    vi.stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## What's new\n\n- The same thing.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- the same thing.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["The same thing."]);
});

test("an unknown installed version asks for nothing: that is the dev build", async () => {
    vi.stubGlobal("fetch", async () => releasesResponse([{ tag_name: "v1.188.0", body: "## What's new\n\n- Newest thing.\n" }]));
    await refreshReleaseNotes();
    expect(updateNotes(undefined)).toEqual([]);
});

test("drafts and pre-releases are not what anybody is being offered", async () => {
    vi.stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.189.0", body: "## What's new\n\n- Unreleased thing.\n", draft: true },
            { tag_name: "v1.188.0", body: "## What's new\n\n- Beta thing.\n", prerelease: true },
            { tag_name: "v1.187.0", body: "## What's new\n\n- Shipped thing.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["Shipped thing."]);
});

test("a failed refresh keeps the previous cached notes", async () => {
    vi.stubGlobal("fetch", async () => releasesResponse([{ tag_name: "v1.187.0", body: "## What's new\n\n- Still here.\n" }]));
    await refreshReleaseNotes();
    vi.stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["Still here."]);
});

test("a dev build never fetches, for the same reason it is never offered an update", async () => {
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
        fetched = true;
        return releasesResponse([]);
    });
    // The repo's own package.json carries the unstamped sentinel, so a test run IS a dev build.
    expect(isDevBuild).toBe(true);
    startReleaseNotesCheck().stop();
    await Promise.resolve();
    expect(fetched).toBe(false);
});
