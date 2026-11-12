import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { statePath } from "../../../state-paths.js";
import { leftoversRelief, LEFTOVERS_KEEP_MS } from "./pressure-reliefs.js";

let base: string;
let work: string;
let history: string;

const put = (path: string, ageMs = 0): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
    if (ageMs > 0) {
        const then = (Date.now() - ageMs) / 1000;
        utimesSync(path, then, then);
    }
};

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pressure-reliefs-"));
    work = join(base, "work");
    history = join(base, "history");
    mkdirSync(history, { recursive: true });
    mkdirSync(work, { recursive: true });
    execFileSync("git", ["-C", work, "init", "-q"]);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("week-old leftovers", () => {
    const artifacts = (): string => statePath(work, ".intentic/records/artifacts/");
    const relief = () =>
        leftoversRelief({ roots: async () => ({ workspace: work, history }), historyRoot: history, programs: async () => [], now: Date.now });

    test("browser captures and artifacts untouched for a week go, oldest first; newer ones and conversations' attachments stay", async () => {
        put(join(artifacts(), "browser/page-old.png"), LEFTOVERS_KEEP_MS + 60_000);
        put(join(artifacts(), "capture-old/side/0001.png"), LEFTOVERS_KEEP_MS + 120_000);
        put(join(artifacts(), "capture-new/side/0001.png"), 60_000);
        put(join(artifacts(), "attachments/49480a06/photo.png"), LEFTOVERS_KEEP_MS * 3);
        expect(await relief().free(async () => false)).toBe(2);
        expect(existsSync(join(artifacts(), "browser/page-old.png"))).toBe(false);
        expect(existsSync(join(artifacts(), "capture-old"))).toBe(false);
        expect(existsSync(join(artifacts(), "capture-new"))).toBe(true);
        expect(existsSync(join(artifacts(), "attachments/49480a06/photo.png"))).toBe(true);
    });

    test("none goes once the disk has room", async () => {
        put(join(artifacts(), "capture-old/side/0001.png"), LEFTOVERS_KEEP_MS + 60_000);
        expect(await relief().free(async () => true)).toBe(0);
        expect(existsSync(join(artifacts(), "capture-old"))).toBe(true);
    });
});
