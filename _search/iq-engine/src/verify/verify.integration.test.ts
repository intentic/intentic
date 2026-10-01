import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEngine, type Engine } from "../index.js";
import { openIndex } from "../store/db.js";
import { makeFixtureWorkspace } from "../testing.js";
import { IQ_DIR } from "../workspace/floor.js";
import { sweep } from "../workspace/scan.js";
import { verifyReferences } from "./check.js";
import { extractReferences } from "./extract.js";
import { indexLookup } from "./lookup.js";

let root: string;
let cleanup: () => Promise<void>;
let engine: Engine;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    // A file long enough for an anchor to drift: `drifting` defined at line 40.
    const filler = Array.from({ length: 39 }, (_, index) => `// filler ${index + 1}`);
    await writeFile(join(root, "alpha/src/long.ts"), [...filler, "export const drifting = (): number => 1;", ""].join("\n"));
    engine = createEngine({ root });
});
afterAll(() => cleanup());

test("a grounded answer: real paths, anchors and names, including one only written (never defined) here", async () => {
    const report = await engine.verify(
        [
            "- `alpha/src/widget.ts:6` — `createWidget` builds one widget.",
            "- `beta/app.py:5` — `WidgetBox.pack` wraps `make_widget()`.",
            "- `alpha/src/registry.ts` builds `defaultWidgets`.",
        ].join("\n"),
    );
    expect(report.issues).toEqual([]);
    expect(report).toMatchObject({ files: 3, anchors: 2 });
});

test("fabrications: a missing file, a line past the end, a drifted anchor, an invented name", async () => {
    const report = await engine.verify(
        [
            "- `alpha/src/gadget.ts` creates gadgets.",
            "- `alpha/src/widget.ts:40` is the factory.",
            "- `alpha/src/long.ts:2` — `drifting` returns one.",
            "- call `createGadget()` to make one.",
        ].join("\n"),
    );
    expect(report.issues.map((issue) => [issue.line, issue.kind, issue.ref])).toEqual([
        [1, "missing-file", "alpha/src/gadget.ts"],
        [2, "past-end", "alpha/src/widget.ts:40"],
        [3, "drifted-anchor", "alpha/src/long.ts:2"],
        [4, "unknown-name", "createGadget()"],
    ]);
    expect(report.issues[0]?.message).toContain("closest: alpha/src/widget.ts");
    expect(report.issues[2]?.message).toBe("`drifting` is at alpha/src/long.ts:40, not near line 2");
    expect(report.issues[3]?.message).toContain("closest: createWidget");
});

test("paths cited from another checkout or relative to a package still resolve", async () => {
    const report = await engine.verify("`/home/someone/clone/beta/app.py:7` and `src/widget.ts:6` (`createWidget`)");
    expect(report.issues).toEqual([]);
});

test("the security floor holds: a file inside the index dir cannot ground a claim, even though it is on disk", async () => {
    const report = await engine.verify("The decoy is `.intentic/local/cache/iq/decoy.txt`, beside `.env`.");
    expect(report.issues.map((issue) => [issue.kind, issue.ref])).toEqual([["missing-file", ".intentic/local/cache/iq/decoy.txt"]]);
});

test("a file edited behind the index is read from disk: a name just written counts, a name just deleted does not", async () => {
    await engine.verify("warm the index");
    await writeFile(join(root, "alpha/src/fresh.ts"), "export const freshlyWritten = 1;\n");
    await writeFile(join(root, "alpha/src/long.ts"), "export const replacement = 2;\n");
    // Read-only, as the CLI sees an index the daemon owns and has not revalidated yet.
    const db = openIndex(join(root, IQ_DIR), "read");
    try {
        const { entries } = await sweep(root, false);
        const report = verifyReferences(
            extractReferences("`freshlyWritten` and `replacement()` exist; `drifting()` is gone."),
            indexLookup(db, root, entries),
        );
        expect(report.issues.map((issue) => issue.ref)).toEqual(["drifting()"]);
    } finally {
        db.close();
    }
});
