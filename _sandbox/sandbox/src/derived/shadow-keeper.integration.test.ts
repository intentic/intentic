import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { readSourceStat, sidecarPathFor, writeSidecar } from "@intentic/fileq/sidecar";
import { fileqSlots, withFileqSlot, type ExecFn } from "./fileq.js";
import { createShadowKeeper, KEEPER_OCR_PAGES, type ShadowKeeper } from "./shadow-keeper.js";

/* The background half: every document in the workspace keeps a current shadow, with nobody opening it. */

let root: string;
let keeper: ShadowKeeper | undefined;
let stamps: Map<string, string>;
// Every file a fake `fileq derive` was handed, in order, and the cap it was asked to OCR to.
let derived: string[];
let ocrPages: string[];
// Files the fake refuses, as fileq refuses a corrupt one.
let corrupt: Set<string>;
let changes: number;
let enabled: boolean;

const quiet = { info: () => undefined, warn: () => undefined };

// A stand-in for the fileq binary: `stamps` answers the table, `derive` writes each file's shadow the way fileq does
// (front matter with the source's stat), or refuses it.
const fakeFileq: ExecFn = async (command, args, options) => {
    const argv = command === "nice" ? args.slice(3) : args;
    expect(options.cwd).toBe(root);
    if (argv[0] === "stamps") {
        return { stdout: `${JSON.stringify(Object.fromEntries(stamps))}\n` };
    }
    ocrPages.push(argv[argv.indexOf("--ocr-pages") + 1] ?? "");
    const files = argv.slice(argv.indexOf("--ocr-pages") + 2);
    const lines: string[] = [];
    for (const relPath of files) {
        derived.push(relPath);
        if (corrupt.has(relPath)) {
            lines.push(JSON.stringify({ kind: "skipped", relPath, reason: "derive-failed (pdf): bad xref" }));
            continue;
        }
        const format = relPath.slice(relPath.lastIndexOf(".") + 1);
        await writeSidecar(root, {
            relPath,
            sourceSha: "sha",
            deriverStamp: stamps.get(format) ?? "unknown v1",
            sourceStat: await readSourceStat(join(root, relPath)),
            doc: { markdown: `## Page 1\n\ntext of ${relPath}`, notes: [] },
            derivedAt: new Date(),
        });
        lines.push(JSON.stringify({ kind: "derived", relPath }));
    }
    const stdout = `${lines.join("\n")}\n`;
    if (lines.every((line) => line.includes('"skipped"'))) {
        throw Object.assign(new Error("exit 1"), { code: 1, stdout });
    }
    return { stdout };
};

const put = async (relPath: string, content = `bytes of ${relPath}`): Promise<void> => {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
};

const start = (limits?: { maxDocuments?: number; maxBytes?: number }): ShadowKeeper => {
    keeper = createShadowKeeper({
        root,
        enabled: async () => enabled,
        logger: quiet,
        onShadowsChanged: () => {
            changes += 1;
        },
        exec: fakeFileq,
        limits: { debounceMs: 5, ...limits },
    });
    return keeper;
};

const shadowExists = (relPath: string): boolean => existsSync(sidecarPathFor(root, relPath));

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "shadow-keeper-"));
    stamps = new Map([
        ["pdf", "pdf v2"],
        ["docx", "docx v1"],
        ["xlsx", "xlsx v1"],
    ]);
    derived = [];
    ocrPages = [];
    corrupt = new Set();
    changes = 0;
    enabled = true;
});
afterEach(async () => {
    keeper?.stop();
    keeper = undefined;
    await rm(root, { recursive: true, force: true });
});

describe("the boot sweep", () => {
    test("derives every document without a shadow, at the keeper's OCR cap, and nothing else", async () => {
        await put("docs/terms.pdf");
        await put("docs/budget.xlsx");
        await put("notes/letter.docx");
        await put("src/app.ts");
        await put("photo.png");
        // Never the keeper's: machine trees, its own state, the reference shelf, agent worktrees, browser profiles.
        await put("node_modules/pkg/manual.pdf");
        await put("refs/other/spec.pdf");
        await put(".claude/worktrees/fix/docs/terms.pdf");
        await put(`${STATE_DIR}/local/browser/profile/a.pdf`);
        await put(`${STATE_DIR}/config/a.pdf`);
        const report = await start().sweep();
        expect(report).toEqual({ state: "done", documents: 3, queued: 3, removed: 0 });
        expect(derived.toSorted()).toEqual(["docs/budget.xlsx", "docs/terms.pdf", "notes/letter.docx"]);
        expect(ocrPages.every((pages) => pages === String(KEEPER_OCR_PAGES))).toBe(true);
        expect(changes).toBeGreaterThan(0);
    });

    test("a second sweep over unchanged files renders nothing: size and mtime vouch for them", async () => {
        await put("docs/terms.pdf");
        await start().sweep();
        derived = [];
        expect(await start().sweep()).toMatchObject({ state: "done", queued: 0 });
        expect(derived).toEqual([]);
    });

    test("a touched file, a new deriver stamp, and a shadow OCR'd shallower than the keeper's cap are each stale", async () => {
        await put("a.pdf");
        await put("b.docx");
        await put("c.pdf");
        await start().sweep();
        derived = [];
        const later = new Date(Date.now() + 60_000);
        await utimes(join(root, "a.pdf"), later, later);
        stamps.set("docx", "docx v2");
        const scan = sidecarPathFor(root, "c.pdf");
        await writeFile(scan, (await readFile(scan, "utf8")).replace(/^deriver: .*$/m, (line) => `${line}\nnote: "OCR stops at 20 pages: draw the rest"`));
        await start().sweep();
        expect(derived.toSorted()).toEqual(["a.pdf", "b.docx", "c.pdf"]);
    });

    test("a shadow whose document went while the daemon was down is removed", async () => {
        await put("gone.pdf");
        await put("kept.pdf");
        await start().sweep();
        await rm(join(root, "gone.pdf"));
        expect(await start().sweep()).toMatchObject({ removed: 1 });
        expect(shadowExists("gone.pdf")).toBe(false);
        expect(shadowExists("kept.pdf")).toBe(true);
        // fileq's own content cache sits beside the shadows and is never taken for an orphan.
        expect(existsSync(join(root, ".intentic/local/cache/derived/.gitignore"))).toBe(true);
    });

    test("a file over the size cap is left to be read on demand", async () => {
        await put("big.pdf", "x".repeat(2000));
        await put("small.pdf", "x");
        await start({ maxBytes: 1000 }).sweep();
        expect(derived).toEqual(["small.pdf"]);
    });

    test("too many documents: reported, not ground through", async () => {
        for (const index of [1, 2, 3, 4]) {
            await put(`docs/${index}.pdf`);
        }
        expect(await start({ maxDocuments: 3 }).sweep()).toMatchObject({ state: "too-many", queued: 0 });
        expect(derived).toEqual([]);
    });

    test("a document fileq refuses is not asked again until it changes", async () => {
        await put("broken.pdf");
        corrupt.add("broken.pdf");
        const first = start();
        await first.sweep();
        expect(await first.sweep()).toMatchObject({ queued: 0 });
        expect(derived).toEqual(["broken.pdf"]);
        await put("broken.pdf", "repaired bytes");
        corrupt.clear();
        expect(await first.sweep()).toMatchObject({ queued: 1 });
    });

    test("switched off, it does nothing at all", async () => {
        await put("docs/terms.pdf");
        enabled = false;
        expect(await start().sweep()).toMatchObject({ state: "off" });
        expect(derived).toEqual([]);
    });

    test("no fileq on PATH: it says so and stops", async () => {
        await put("docs/terms.pdf");
        keeper = createShadowKeeper({
            root,
            enabled: async () => true,
            logger: quiet,
            onShadowsChanged: () => undefined,
            exec: async () => {
                throw Object.assign(new Error("spawn fileq ENOENT"), { code: "ENOENT" });
            },
        });
        expect(await keeper.sweep()).toMatchObject({ state: "no-fileq" });
    });
});

describe("watcher batches", () => {
    test("a created or edited document renders, a deleted one loses its shadow", async () => {
        const live = start();
        await put("docs/new.pdf");
        live.changed(["docs/new.pdf", "src/app.ts"]);
        await live.idle();
        expect(derived).toEqual(["docs/new.pdf"]);
        expect(shadowExists("docs/new.pdf")).toBe(true);

        await put("docs/new.pdf", "edited, and longer than before");
        live.changed(["docs/new.pdf"]);
        await live.idle();
        expect(derived).toEqual(["docs/new.pdf", "docs/new.pdf"]);

        await rm(join(root, "docs/new.pdf"));
        const before = changes;
        live.changed(["docs/new.pdf"]);
        await live.idle();
        expect(shadowExists("docs/new.pdf")).toBe(false);
        expect(changes).toBeGreaterThan(before);
    });

    test("a rename is a removal and a render; a deleted folder takes its shadows with it", async () => {
        const live = start();
        await put("old/a.pdf");
        await put("old/b.docx");
        await live.sweep();
        await rm(join(root, "old"), { recursive: true });
        await put("new/a.pdf");
        live.changed(["old", "new/a.pdf"]);
        await live.idle();
        expect(shadowExists("old/a.pdf")).toBe(false);
        expect(existsSync(join(root, ".intentic/local/cache/derived/old"))).toBe(false);
        expect(shadowExists("new/a.pdf")).toBe(true);
    });

    test("a burst of saves to one file renders it once", async () => {
        const live = start();
        await put("docs/draft.docx");
        live.changed(["docs/draft.docx"]);
        live.changed(["docs/draft.docx"]);
        live.changed(["docs/draft.docx"]);
        await live.idle();
        expect(derived).toEqual(["docs/draft.docx"]);
    });

    test("paths it never keeps are ignored", async () => {
        const live = start();
        await put("node_modules/x/manual.pdf");
        live.changed(["node_modules/x/manual.pdf", "refs/a.pdf"]);
        await live.idle();
        expect(derived).toEqual([]);
    });
});

describe("the fileq slots: interactive renders first", () => {
    const gate = () => {
        let open = (): void => undefined;
        const wait = new Promise<void>((resolve) => {
            open = resolve;
        });
        return { open, wait };
    };

    test("the background holds at most one slot and never takes one an interactive caller is waiting for", async () => {
        const order: string[] = [];
        const job = (name: string, until: Promise<void>) => async (): Promise<void> => {
            order.push(`start ${name}`);
            await until;
            order.push(`end ${name}`);
        };
        const background1 = gate();
        const interactive1 = gate();
        const runs = [withFileqSlot(job("bg1", background1.wait), "background")];
        runs.push(withFileqSlot(job("bg2", Promise.resolve()), "background"));
        // bg2 waits: the background's one slot is bg1's.
        await Bun.sleep(1);
        expect(fileqSlots()).toMatchObject({ running: 1, background: 1, waiting: 1 });
        runs.push(withFileqSlot(job("i1", interactive1.wait)));
        runs.push(withFileqSlot(job("i2", Promise.resolve())));
        await Bun.sleep(1);
        expect(order).toEqual(["start bg1", "start i1"]);
        // bg1 ends: its slot goes to the waiting interactive caller, not to bg2.
        background1.open();
        await Bun.sleep(1);
        expect(order.slice(2, 5)).toEqual(["end bg1", "start i2", "end i2"]);
        interactive1.open();
        await Promise.all(runs);
        expect(order.indexOf("start bg2")).toBeGreaterThan(order.indexOf("end i2"));
        expect(fileqSlots()).toEqual({ running: 0, background: 0, waiting: 0 });
    });
});

test("switched back on, it sweeps; already on, reconsidering does nothing", async () => {
    await put("docs/terms.pdf");
    enabled = false;
    const live = start();
    await live.sweep();
    enabled = true;
    await live.reconsider();
    expect(derived).toEqual(["docs/terms.pdf"]);
    // Already on: nothing more to do.
    await live.reconsider();
    expect(derived).toEqual(["docs/terms.pdf"]);
});
