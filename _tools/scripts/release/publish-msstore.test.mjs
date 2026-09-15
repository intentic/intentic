// Pins the decisions publish-msstore.mjs makes before it touches the Microsoft Store: which refs are releases, which
// release a draft is carrying, what to do about a submission already in certification, and what the listing is told.
// The HTTP calls around them are the Store's to answer; these are the answers that would otherwise be found out by
// submitting the wrong thing to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulletsUnder, checksumFor, compareReleases, nextAction, releaseVersionOf, versionOfPackageUrl, whatsNewFor } from "./publish-msstore.mjs";

const DOWNLOAD = "https://github.com/intentic/intentic/releases/download";

test("a tag is a release and a branch is not: the Store submits a release, not a ref", () => {
    assert.equal(releaseVersionOf("v1.249.0"), "1.249.0");
    assert.equal(releaseVersionOf("1.249.0"), "1.249.0");
    assert.equal(releaseVersionOf("v2.0.0-rc.1"), "2.0.0-rc.1");
    assert.equal(releaseVersionOf("main"), "");
    assert.equal(releaseVersionOf("1.249"), "");
    assert.equal(releaseVersionOf(undefined), "");
});

test("releases order by number, so a rerun of an old tag is recognisable", () => {
    assert.ok(compareReleases("1.249.0", "1.250.0") < 0);
    assert.ok(compareReleases("1.250.0", "1.249.0") > 0);
    assert.equal(compareReleases("1.249.0", "1.249.0"), 0);
    assert.ok(compareReleases("1.9.0", "1.10.0") < 0);
});

test("the release a draft carries is read back out of its package URL", () => {
    assert.equal(versionOfPackageUrl(`${DOWNLOAD}/v1.249.0/Intentic-1.249.0-x64-setup.exe`), "1.249.0");
    assert.equal(versionOfPackageUrl(`${DOWNLOAD}/v2.0.0-rc.1/Intentic-2.0.0-rc.1-x64-setup.exe`), "2.0.0-rc.1");
    // The vanity path always resolves to the newest release, which is why it must never be a package URL.
    assert.equal(versionOfPackageUrl("https://intentic.dev/desktop/windows"), "");
    assert.equal(versionOfPackageUrl(undefined), "");
});

test("an ordinary release stages its package and submits", () => {
    assert.equal(nextAction({ version: "1.250.0", staged: false, draftVersion: "1.249.0", ongoing: "" }), "stage");
});

test("a draft already pointing at this release is finished rather than restaged", () => {
    assert.equal(nextAction({ version: "1.250.0", staged: true, draftVersion: "1.250.0", ongoing: "" }), "submit");
});

test("this release already in certification is done, not resubmitted", () => {
    assert.equal(nextAction({ version: "1.250.0", staged: true, draftVersion: "1.250.0", ongoing: "s-1" }), "done");
});

test("another release in certification defers this one: the draft cannot be touched", () => {
    assert.equal(nextAction({ version: "1.250.0", staged: false, draftVersion: "1.249.0", ongoing: "s-1" }), "defer");
});

test("a draft past this release refuses it: an old tag must not walk the Store backwards", () => {
    assert.equal(nextAction({ version: "1.249.0", staged: false, draftVersion: "1.250.0", ongoing: "" }), "refuse");
    assert.equal(nextAction({ version: "1.249.0", staged: false, draftVersion: "1.250.0", ongoing: "s-1" }), "refuse");
});

test("an empty listing is staged, not refused: a product with no package yet has no draft version", () => {
    assert.equal(nextAction({ version: "1.250.0", staged: false, draftVersion: "", ongoing: "" }), "stage");
});

test("bullets are read from under one heading and stop at the next", () => {
    const body = ["## What's new", "- one", "- two", "", "## Breaking changes", "- three", "## Internal", "- four"].join("\n");
    assert.deepEqual(bulletsUnder(body, "What's new"), ["one", "two"]);
    assert.deepEqual(bulletsUnder(body, "Breaking changes"), ["three"]);
    assert.deepEqual(bulletsUnder(body, "Nothing here"), []);
});

test("what's new leads with breaking changes and always ends with the release notes link", () => {
    const body = ["## What's new", "- a new screen", "", "## Breaking changes", "- the old flag is gone"].join("\n");
    const notes = whatsNewFor(body, "https://example.test/v1");
    assert.deepEqual(notes.split("\n"), ["• Breaking: the old flag is gone", "• a new screen", "Full release notes: https://example.test/v1"]);
});

test("a release with no user-facing notes still points at its notes", () => {
    assert.equal(whatsNewFor("", "https://example.test/v1"), "Full release notes: https://example.test/v1");
});

test("an overlong release loses bullets, never the link: the Store caps this field at 1500", () => {
    const body = ["## What's new", ...Array.from({ length: 200 }, (_, index) => `- ${"x".repeat(60)} ${index}`)].join("\n");
    const notes = whatsNewFor(body, "https://example.test/v1");
    assert.ok(notes.length <= 1500, `${notes.length} characters is over the Store's cap`);
    assert.ok(notes.endsWith("Full release notes: https://example.test/v1"));
    assert.ok(notes.split("\n").length > 2, "bullets that fit are kept");
});

test("the release's own checksum is found for the artifact being submitted", () => {
    const sums = ["abc123  ./Intentic-1.249.0-x86_64.AppImage", "def456  ./Intentic-1.249.0-x64-setup.exe", "0f0f0f  ./SHA256SUMS"].join("\n");
    assert.equal(checksumFor(sums, "Intentic-1.249.0-x64-setup.exe"), "def456");
    assert.equal(checksumFor(sums, "Intentic-1.250.0-x64-setup.exe"), undefined);
    assert.equal(checksumFor("beef01 *Intentic-1.249.0-x64-setup.exe", "Intentic-1.249.0-x64-setup.exe"), "beef01");
});
