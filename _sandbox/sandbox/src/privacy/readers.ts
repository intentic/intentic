import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAs } from "../workload/workload-class.js";

// Reading an image or a PDF on this machine, so what an untrusted provider would have seen as pixels or pages reaches it
// as masked text instead. Poppler's `pdftotext` ships in the image; `tesseract` with its Polish data comes with the
// `privacy` image pack. Each reader reports itself missing rather than failing, and the gateway then withholds.

export interface LocalReaders {
    // Whether an image can be read to text here.
    readonly ocr: () => Promise<boolean>;
    // An image's text, or undefined when there is no reader or it read nothing.
    readonly readImage: (data: Buffer) => Promise<string | undefined>;
    // A PDF's text layer, falling back to reading its pages as images; undefined when neither yields text.
    readonly readPdf: (data: Buffer) => Promise<string | undefined>;
}

// A page of text a person could read on a phone is a few thousand characters; a reading many times that is a dataset,
// and still worth masking whole rather than truncating, but not worth waiting minutes for.
const READ_TIMEOUT_MS = 60_000;
// Scanned pages read through OCR, at most; a longer scan is withheld past this point rather than holding the request.
const OCR_PAGES = 20;

interface RunResult {
    readonly code: number | null;
    readonly stdout: string;
}

const run = (command: string, args: readonly string[], input?: Buffer): Promise<RunResult> =>
    new Promise((resolve) => {
        const child = spawnAs({ class: "toolchain" }, command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => child.kill("SIGKILL"), READ_TIMEOUT_MS);
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.once("error", () => {
            clearTimeout(timer);
            resolve({ code: null, stdout: "" });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
        });
        if (input !== undefined) {
            child.stdin?.on("error", () => undefined);
            child.stdin?.end(input);
        }
    });

// The languages tesseract has data for here, Polish first when present; read once per process.
const tesseractLanguages = async (): Promise<string | undefined> => {
    const listed = await run("tesseract", ["--list-langs"]);
    if (listed.code !== 0) {
        return undefined;
    }
    const langs = new Set(listed.stdout.split("\n").map((line) => line.trim()));
    const wanted = ["pol", "eng"].filter((lang) => langs.has(lang));
    return wanted.length === 0 ? undefined : wanted.join("+");
};

const meaningful = (text: string): string | undefined => (text.trim() === "" ? undefined : text);

export const createLocalReaders = (): LocalReaders => {
    let languages: Promise<string | undefined> | undefined;
    const ocrLanguages = (): Promise<string | undefined> => (languages ??= tesseractLanguages());
    const readImage = async (data: Buffer): Promise<string | undefined> => {
        const lang = await ocrLanguages();
        if (lang === undefined) {
            return undefined;
        }
        const read = await run("tesseract", ["stdin", "stdout", "-l", lang, "--psm", "3"], data);
        return read.code === 0 ? meaningful(read.stdout) : undefined;
    };
    return {
        ocr: async () => (await ocrLanguages()) !== undefined,
        readImage,
        readPdf: async (data) => {
            // Poppler writes UTF-8 unless told otherwise, which is what is read back here.
            const layer = await run("pdftotext", ["-layout", "-", "-"], data);
            const text = layer.code === 0 ? meaningful(layer.stdout) : undefined;
            if (text !== undefined || (await ocrLanguages()) === undefined) {
                return text;
            }
            // A scan: no text layer, so its pages are rendered and read like images.
            const dir = await mkdtemp(join(tmpdir(), "privacy-pdf-"));
            try {
                await writeFile(join(dir, "in.pdf"), data);
                const rendered = await run("pdftoppm", ["-r", "150", "-png", "-l", String(OCR_PAGES), join(dir, "in.pdf"), join(dir, "page")]);
                if (rendered.code !== 0) {
                    return undefined;
                }
                const pages = (await readdir(dir)).filter((name) => name.startsWith("page") && name.endsWith(".png")).toSorted();
                const texts: string[] = [];
                for (const page of pages) {
                    const read = await run("tesseract", [join(dir, page), "stdout", "-l", (await ocrLanguages()) ?? "eng"]);
                    if (read.code === 0) {
                        texts.push(read.stdout);
                    }
                }
                return meaningful(texts.join("\n\f\n"));
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    };
};
