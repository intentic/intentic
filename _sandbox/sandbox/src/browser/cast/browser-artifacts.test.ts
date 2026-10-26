import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { join } from "node:path";
import { browserOutputDir, placeArtifact, placedNote, screenshotImage, writesFilename } from "./browser-artifacts.js";

const OUTPUT = browserOutputDir(WORKSPACE_ROOT);

// Where a name lands inside the output dir, built the way placement builds it.
const inOutput = (name: string): string => join(OUTPUT, name);

// The files already on disk, as placement's existence check sees them; empty unless a case says otherwise.
const onDisk = new Set<string>();

afterEach(() => onDisk.clear());

const place = (filename: string): Promise<string> => placeArtifact(OUTPUT, filename, async (path) => onDisk.has(path));

// The whole point: a bare name resolves against the backend's cwd inside @playwright/mcp, which is the owner's main tree.
test("a model-named file is placed in the output dir, out of every repository", async () => {
    expect(await place("tt-viewport.png")).toBe("/work/.intentic/records/artifacts/browser/tt-viewport.png");
});

test.each([
    ["../../escape.png", `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser/escape.png`],
    ["/etc/passwd.png", `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser/passwd.png`],
    // A worktree's absolute path in the agent's namespace is the main tree's in the backend's: it keeps its name only.
    [`${WORKSPACE_ROOT}/intentic/docs/report.md`, `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser/report.md`],
])("a name that would escape the output dir keeps only its basename: %s", async (filename, expected) => {
    expect(await place(filename)).toBe(expected);
});

test("a subdirectory the agent asked for is honoured inside the output dir", async () => {
    expect(await place("before/nav.png")).toBe("/work/.intentic/records/artifacts/browser/before/nav.png");
});

test("a free name already resolved into the output dir is left as it is", async () => {
    expect(await place("/work/.intentic/records/artifacts/browser/shot.png")).toBe("/work/.intentic/records/artifacts/browser/shot.png");
});

// A reused name used to overwrite the earlier shot, so an older transcript showed a newer, unrelated picture.
test("a name an earlier file already holds takes the next free number, and the note says why", async () => {
    onDisk.add(inOutput("after.png"));
    const placed = await place("after.png");
    expect(placed).toBe(inOutput("after-2.png"));
    expect(placedNote("after.png", placed, OUTPUT)).toBe(
        `Saved to ${inOutput("after-2.png")} (an earlier file already has that name): files a browser tool writes always land in ` +
            `${OUTPUT}, outside every repository. Read it from that absolute path.`,
    );
});

test("a note for a file that kept its name says only where it went", () => {
    expect(placedNote("after.png", inOutput("after.png"), OUTPUT)).toContain(`Saved to ${inOutput("after.png")}: files a browser tool`);
});

test("numbering skips every name already taken", async () => {
    onDisk.add(inOutput("after.png"));
    onDisk.add(inOutput("after-2.png"));
    expect(await place("after.png")).toBe(inOutput("after-3.png"));
});

test("a taken name already inside the output dir is numbered too, subdirectory kept", async () => {
    onDisk.add(inOutput("before/nav.png"));
    expect(await place(inOutput("before/nav.png"))).toBe(inOutput("before/nav-2.png"));
});

test("a name with no extension is numbered at its end", async () => {
    onDisk.add(inOutput("shot"));
    expect(await place("shot")).toBe(inOutput("shot-2"));
});

test.each(["browser_take_screenshot", "browser_snapshot", "browser_console_messages", "browser_network_requests", "browser_pdf_save", "browser_storage_state"])(
    "%s writes the file it names",
    (tool) => {
        expect(writesFilename(tool)).toBe(true);
    },
);

test.each(["browser_run_code_unsafe", "browser_set_storage_state", "webmcp_export"])("%s does not write the file it names", (tool) => {
    expect(writesFilename(tool)).toBe(false);
});

// screenshotImage: turns the tool's answer, a markdown link relative to the agent's cwd, back into a
// workspace-root-relative path the chat can render.
test("a screenshot's answer becomes a workspace path the chat can render", () => {
    const answer = "### Result\n- [Screenshot of viewport](../.intentic/records/artifacts/browser/page-2026-07-30.png)\n";
    expect(screenshotImage(answer, "/work/myrepo", OUTPUT)).toEqual({
        type: "image",
        path: ".intentic/records/artifacts/browser/page-2026-07-30.png",
    });
});

test("a screenshot taken at the workspace root resolves the same way", () => {
    const answer = "- [Screenshot of viewport](.intentic/records/artifacts/browser/shot.png)";
    expect(screenshotImage(answer, "/work", OUTPUT)).toEqual({ type: "image", path: ".intentic/records/artifacts/browser/shot.png" });
});

test.each([
    ["a link outside the output dir", "- [Something](../src/index.ts)"],
    ["no link at all", "Took the screenshot."],
])("%s produces no picture", (_case, answer) => {
    expect(screenshotImage(answer, "/work/myrepo", OUTPUT)).toBeUndefined();
});
