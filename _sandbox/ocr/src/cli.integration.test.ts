import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { requires } from "@intentic/testing/requires";
import { ocrInstalled, ocrModelDir } from "./models.js";

// The `ocr` command as a process, against the real models, where they are.

const ocr = requires(ocrInstalled(), `the PP-OCRv6 models at ${ocrModelDir()} (the privacy image pack)`);
const CLI = join(import.meta.dir, "cli.ts");

let dir: string;
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ocr-cli-"));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

const page = async (name: string, words: string): Promise<string> => {
    const path = join(dir, name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="900" height="200" fill="#fff"/><text x="40" y="110" font-family="DejaVu Sans, sans-serif" font-size="48" fill="#111">${words}</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path);
    return path;
};

test.skipIf(!ocr.runs)(ocr.title("orphaned by whoever started it, it stops at the next image"), async () => {
    const images = [await page("one.png", "Faktura 1"), await page("two.png", "Faktura 2"), await page("three.png", "Faktura 3")];
    const out = join(dir, "out.txt");
    const err = join(dir, "err.txt");
    // The shell starts the reader in the background and leaves as soon as the first page is printed, as a fileq stopped
    // mid-scan would; the reader is then nobody's child.
    execFileSync("sh", [
        "-c",
        `"$0" "${CLI}" "$@" > "${out}" 2> "${err}" & while [ ! -s "${out}" ]; do sleep 0.1; done`,
        process.execPath,
        ...images,
    ]);
    // Settles once the reader exits: its stderr says why it stopped.
    for (let waited = 0; !readFileSync(err, "utf8").includes("stopping") && waited < 60_000; waited += 100) {
        await Bun.sleep(100);
    }
    expect(readFileSync(err, "utf8")).toContain("the process that asked is gone; stopping");
    expect(readFileSync(out, "utf8")).not.toContain("3");
}, 120_000);
