/* The machine-wide OCR slots: flock locks in a directory every process shares. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { ocrSlotCount, runInOcrSlot } from "./ocr-slots.js";
import { onPath } from "./tools.js";

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fileq-ocr-slots-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("ocrSlotCount", () => {
    test("one slot per eight cores and per 8 GiB, never none and never more than two", () => {
        expect(ocrSlotCount(4, 64 * 1024 ** 3)).toBe(1);
        expect(ocrSlotCount(16, 64 * 1024 ** 3)).toBe(2);
        expect(ocrSlotCount(64, 256 * 1024 ** 3)).toBe(2);
        expect(ocrSlotCount(16, 12 * 1024 ** 3)).toBe(1);
        expect(ocrSlotCount(1, 1024 ** 3)).toBe(1);
    });
});

describe("runInOcrSlot", () => {
    const flock = requires(onPath("flock"), "flock (util-linux) on PATH");
    // Each run notes when it starts and ends in one shared log, so overlapping runs interleave there.
    const run = (name: string, slots: number) =>
        runInOcrSlot("sh", ["-c", `echo "start ${name}" >> ${dir}/log; sleep 0.4; echo "end ${name}" >> ${dir}/log; echo done ${name}`], {
            slots,
            lockDir: dir,
            timeoutMs: 30_000,
        });
    const log = (): string[] => readFileSync(join(dir, "log"), "utf8").trim().split("\n");

    test.skipIf(!flock.runs)(flock.title("with one slot, a second run waits for the first to end"), async () => {
        const [first, second] = await Promise.all([run("a", 1), run("b", 1)]);
        expect(first.stdout.text).toBe("done a\n");
        expect(second.stdout.text).toBe("done b\n");
        const lines = log();
        expect(lines).toHaveLength(4);
        expect(lines[0]?.replace(/ .$/, "")).toBe("start");
        expect(lines[1]).toBe(lines[0]?.replace("start", "end"));
    });

    test.skipIf(!flock.runs)(flock.title("with two slots, two runs go at once"), async () => {
        await Promise.all([run("a", 2), run("b", 2)]);
        expect(log().map((line) => line.split(" ")[0])).toEqual(["start", "start", "end", "end"]);
    });

    test.skipIf(!flock.runs)(flock.title("the command's own exit code and output come back"), async () => {
        const result = await runInOcrSlot("sh", ["-c", "echo read; exit 1"], { slots: 1, lockDir: dir, timeoutMs: 30_000 });
        expect(result.exitCode).toBe(1);
        expect(result.stdout.text).toBe("read\n");
    });

    test.skipIf(!flock.runs)(flock.title("a lock directory flock cannot use costs the slot, not the run"), async () => {
        const result = await runInOcrSlot("sh", ["-c", "echo read"], { slots: 1, lockDir: join(dir, "missing", "deeper"), timeoutMs: 30_000 });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.text).toBe("read\n");
    });
});
