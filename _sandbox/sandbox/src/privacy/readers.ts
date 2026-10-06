import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrInstalled } from "@intentic/ocr/models";
import { type OcrLine, pageText, type TextReader } from "@intentic/ocr/paddle-ocr";
import { decodeImage } from "@intentic/ocr/raster";
import { spawnAs } from "../workload/workload-class.js";

// Reading an image or a PDF on this machine, so what an untrusted provider is sent can be checked for personal data
// first. The text reader is PaddleOCR's PP-OCRv6 (@intentic/ocr), whose models come with the `privacy` image pack; poppler's
// `pdftotext` ships in the image, its `pdftoppm` with the pack. A reader that is missing says so rather than failing,
// and the gateway then holds the image or document back.

// An image as the reader saw it, upright: its size, and every line of text on it with where it sits, in reading
// order. No lines: nothing to read.
export interface ImageReading {
    readonly width: number;
    readonly height: number;
    readonly lines: readonly OcrLine[];
}

export interface LocalReaders {
    // Whether an image can be read here.
    readonly ocr: () => Promise<boolean>;
    // An image's lines, or undefined when there is no reader or the bytes are not an image it can decode.
    readonly readImage: (data: Buffer) => Promise<ImageReading | undefined>;
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

const meaningful = (text: string): string | undefined => (text.trim() === "" ? undefined : text);

export interface LocalReadersDeps {
    // The loaded text reader, or undefined when its models are not installed or would not load. Called on first use.
    readonly textReader: () => Promise<TextReader | undefined>;
    // Whether the reader's models are installed, without loading them.
    readonly installed?: () => boolean;
}

export const createLocalReaders = ({ textReader, installed = () => ocrInstalled() }: LocalReadersDeps): LocalReaders => {
    const readImage = async (data: Buffer): Promise<ImageReading | undefined> => {
        const reader = await textReader();
        if (reader === undefined) {
            return undefined;
        }
        const image = await decodeImage(data);
        return image === undefined ? undefined : { width: image.rgba.width, height: image.rgba.height, lines: await reader.read(image.rgba) };
    };
    return {
        ocr: async () => installed(),
        readImage,
        readPdf: async (data) => {
            // Poppler writes UTF-8 unless told otherwise, which is what is read back here.
            const layer = await run("pdftotext", ["-layout", "-", "-"], data);
            const text = layer.code === 0 ? meaningful(layer.stdout) : undefined;
            if (text !== undefined || !installed()) {
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
                    const reading = await readImage(await readFile(join(dir, page)));
                    if (reading !== undefined) {
                        texts.push(pageText(reading.lines));
                    }
                }
                return meaningful(texts.join("\n\f\n"));
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    };
};
