import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { isDevBuild } from "../../version.js";
import {
    breakingNotes,
    parseBreakingNotes,
    parseReleaseNotes,
    parseWithdrawn,
    readReleases,
    refreshReleaseNotes,
    startReleaseNotesCheck,
    updateNotes,
    withdrawnRelease,
} from "./release-notes.js";

afterEach(() => {
    unstubAllGlobals();
});

// The body shape publish-github.sh writes: the user-facing section first, the commit-subject grouping under it.
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
    expect(parseReleaseNotes(RELEASE_BODY)).toEqual(["Your models stay in the order you set them.", "The commit box keeps a full message."]);
});

test("a release with nothing a user would notice yields no notes", () => {
    expect(parseReleaseNotes("### Features\n\n- ordered model picker\n")).toEqual([]);
    expect(parseReleaseNotes("")).toEqual([]);
});

// The body publish-github.sh writes when a commit declares a break: its own section, above What's new.
const BREAKING_BODY = ["## Breaking changes", "", "- The old picker layout is gone — use the new list.", "", ...RELEASE_BODY.split("\n")].join("\n");

test("reads the breaking section apart from the notes", () => {
    expect(parseBreakingNotes(BREAKING_BODY)).toEqual(["The old picker layout is gone — use the new list."]);
    expect(parseReleaseNotes(BREAKING_BODY)).toEqual(["Your models stay in the order you set them.", "The commit box keeps a full message."]);
    expect(parseBreakingNotes(RELEASE_BODY)).toEqual([]);
});

test("collects every breaking sentence in the gap, and a release that only breaks still counts", async () => {
    stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## Breaking changes\n\n- The export command is gone.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- Middle thing.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(breakingNotes("1.186.0")).toEqual(["The export command is gone."]);
    expect(updateNotes("1.186.0")).toEqual(["Middle thing."]);
    expect(breakingNotes("1.188.0")).toEqual([]);
});

test("collects the notes for every release newer than this sandbox, and none of the older ones", async () => {
    stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## What's new\n\n- Newest thing.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- Middle thing.\n" },
            { tag_name: "v1.186.0", body: "## What's new\n\n- Already installed.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["Newest thing.", "Middle thing."]);
    // Nothing is newer than the newest release itself.
    expect(updateNotes("1.188.0")).toEqual([]);
});

test("says one change once, however many releases carried it", async () => {
    // The fixture differs only in case, to prove the same-sentence check ignores it.
    stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.188.0", body: "## What's new\n\n- The same thing.\n" },
            { tag_name: "v1.187.0", body: "## What's new\n\n- the same thing.\n" },
        ]),
    );
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["The same thing."]);
});

test("an unknown installed version asks for nothing: that is the dev build", async () => {
    stubGlobal("fetch", async () => releasesResponse([{ tag_name: "v1.188.0", body: "## What's new\n\n- Newest thing.\n" }]));
    await refreshReleaseNotes();
    expect(updateNotes(undefined)).toEqual([]);
});

test("drafts and pre-releases are not what anybody is being offered", async () => {
    stubGlobal("fetch", async () =>
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
    stubGlobal("fetch", async () => releasesResponse([{ tag_name: "v1.187.0", body: "## What's new\n\n- Still here.\n" }]));
    await refreshReleaseNotes();
    stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshReleaseNotes();
    expect(updateNotes("1.186.0")).toEqual(["Still here."]);
});

test("a dev build never fetches, for the same reason it is never offered an update", async () => {
    let fetched = false;
    stubGlobal("fetch", async () => {
        fetched = true;
        return releasesResponse([]);
    });
    // The repo's own package.json carries the unstamped sentinel, so running tests counts as a dev build.
    expect(isDevBuild).toBe(true);
    startReleaseNotesCheck().stop();
    await Promise.resolve();
    expect(fetched).toBe(false);
});

// The body the release pipeline's rollback leaves on a release it takes back: its reason on a line of its own, above
// the notes the release shipped with.
const WITHDRAWN_BODY = ["Withdrawn: it lost conversations on boot for some sandboxes", "", ...RELEASE_BODY.split("\n")].join("\n");

test("a release is withdrawn by a line that starts `Withdrawn:`, with or without a reason", () => {
    expect(parseWithdrawn(WITHDRAWN_BODY)).toEqual({ reason: "it lost conversations on boot for some sandboxes" });
    expect(parseWithdrawn(`## What's new\n\n  Withdrawn:   \n`)).toEqual({});
    expect(parseWithdrawn(RELEASE_BODY)).toBeUndefined();
    // A note that merely mentions the word, or a bullet, withdraws nothing.
    expect(parseWithdrawn("## What's new\n\n- Withdrawn: releases are marked on the update card.\n")).toBeUndefined();
});

test("a withdrawn release is read though the rollback marked it a pre-release, and its notes are never offered", () => {
    const read = readReleases([
        { tag_name: "v1.189.0", body: "## What's new\n\n- Newest thing.\n" },
        { tag_name: "v1.188.0", body: WITHDRAWN_BODY, prerelease: true },
        { tag_name: "v1.187.0", body: "Withdrawn:\n\n## What's new\n\n- Taken back too.\n" },
        { tag_name: "v1.186.0", body: "## What's new\n\n- Beta thing.\n", prerelease: true },
        { tag_name: "v1.185.0", body: "Withdrawn: a draft is nobody's release", draft: true },
    ]);
    expect(read).toEqual({
        notes: [{ version: "1.189.0", notes: ["Newest thing."], breaking: [] }],
        withdrawn: [{ version: "1.188.0", reason: "it lost conversations on boot for some sandboxes" }, { version: "1.187.0" }],
    });
});

test("a sandbox running a withdrawn release is told so, and one on a standing release is not", async () => {
    stubGlobal("fetch", async () =>
        releasesResponse([
            { tag_name: "v1.189.0", body: "## What's new\n\n- Newest thing.\n" },
            { tag_name: "v1.188.0", body: WITHDRAWN_BODY, prerelease: true },
        ]),
    );
    await refreshReleaseNotes();
    expect(withdrawnRelease("1.188.0")).toEqual({ version: "1.188.0", reason: "it lost conversations on boot for some sandboxes" });
    expect(withdrawnRelease("1.189.0")).toBeUndefined();
    // Its notes are no update notes, whoever is behind it.
    expect(updateNotes("1.187.0")).toEqual(["Newest thing."]);
});
