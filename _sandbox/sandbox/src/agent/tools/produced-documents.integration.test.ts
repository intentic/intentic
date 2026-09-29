import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProducedDocuments } from "./produced-documents.js";

/* Which deliverables a scan finds on disk: written after the command started, by the dirty list or by a name the
   command gave, and nothing else. A real tree, since a stat's ctime is the whole of the attribution. */

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

const tree = (): string => {
    const root = mkdtempSync(join(tmpdir(), "produced-documents-"));
    roots.push(root);
    return root;
};

const write = (root: string, path: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), "bytes");
};

// Longer than the kernel's timestamp tick, so a write lands clearly before or after the command's start.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

test("a deliverable written during the command is found; one written before it, or source, is not", async () => {
    const root = tree();
    write(root, "old/brief.docx");
    await tick();
    const since = Date.now();
    await tick();
    write(root, "decks/q3.pptx");
    write(root, "make_deck.py");
    const scan = scanProducedDocuments({ localCwd: root, effectiveCwd: root }, async () => ["old/brief.docx", "decks/q3.pptx", "make_deck.py"]);
    expect(await scan(since, [])).toEqual(["decks/q3.pptx"]);
});

test("a file git never lists is found when the command names it, absolutely or from the root", async () => {
    const root = tree();
    const since = Date.now() - 5;
    await tick();
    write(root, "build/report.pdf");
    write(root, "build/site/index.html");
    const scan = scanProducedDocuments({ localCwd: root, effectiveCwd: root }, async () => []);
    expect(await scan(since, [`weasyprint page.html ${root}/build/report.pdf`, "wrote ./build/site/index.html"])).toEqual([
        "build/report.pdf",
        "build/site/index.html",
    ]);
});

test("names are read from the root the agent sees and stat'ed in the daemon's copy, which an isolated turn keeps apart", async () => {
    const copy = tree();
    const since = Date.now() - 5;
    await tick();
    write(copy, "out/summary.xlsx");
    const scan = scanProducedDocuments({ localCwd: copy, effectiveCwd: "/work" }, async () => []);
    expect(await scan(since, ["saved /work/out/summary.xlsx"])).toEqual(["out/summary.xlsx"]);
});

test("a name that climbs out of the workspace, a missing file, and a locked state file are never reported", async () => {
    const root = tree();
    const since = Date.now() - 5;
    await tick();
    write(root, ".intentic/secrets/auth/export.pdf");
    const scan = scanProducedDocuments({ localCwd: root, effectiveCwd: root }, async () => [".intentic/secrets/auth/export.pdf", "gone.docx"]);
    expect(await scan(since, ["cp ../../etc/secret.pdf /elsewhere/copy.pdf"])).toEqual([]);
});

test("a dirty list that cannot be read still leaves the named files", async () => {
    const root = tree();
    const since = Date.now() - 5;
    await tick();
    write(root, "letter.docx");
    const scan = scanProducedDocuments({ localCwd: root, effectiveCwd: root }, () => Promise.reject(new Error("git is gone")));
    expect(await scan(since, ["python letter.py > letter.docx"])).toEqual(["letter.docx"]);
});
