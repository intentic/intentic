import type { SpawnOptions } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrInstalled } from "@intentic/ocr/models";
import { type OcrLine, readingOrder, type TextReader } from "@intentic/ocr/paddle-ocr";
import { decodeImage } from "@intentic/ocr/raster";
import { spawnAs } from "../workload/workload-class.js";
import { layerLines, PDF_DPI, type PdfPage, type PdfReading, textLayerOf } from "./pdf-pages.js";

// Reading an image, a PDF or another document on this machine, so what an untrusted provider is sent can be checked for
// personal data first. The text reader is PaddleOCR's PP-OCRv6 (@intentic/ocr), whose models come with the `privacy`
// image pack, as poppler (`pdftoppm`, `pdftotext`) does; office files and the like are read by `fileq`. A reader that is
// missing says so rather than failing, and the gateway then holds the image or document back.

// An image as the reader saw it, upright: its size, and every line of text on it with where it sits, in reading
// order. No lines: nothing to read.
export interface ImageReading {
    readonly width: number;
    readonly height: number;
    readonly lines: readonly OcrLine[];
    // More than one: an animation, of which only the first frame was read.
    readonly frames?: number;
}

export interface LocalReaders {
    // Whether an image can be read here.
    readonly ocr: () => Promise<boolean>;
    // An image's lines, or undefined when there is no reader or the bytes are not an image it can decode.
    readonly readImage: (data: Buffer) => Promise<ImageReading | undefined>;
    // A PDF's pages as drawn here (pdf-pages.ts), each with its lines: the text layer's, and what the text reader reads
    // of the rest. Undefined when it cannot be drawn (no poppler, not a PDF, a password), has more pages than are read,
    // or has more scanned pages than are read through OCR.
    readonly readPdf: (data: Buffer) => Promise<PdfReading | undefined>;
    // The same pages drawn again as JPEG, the pictures readPdf's lines sit on; undefined when they cannot be.
    readonly drawPdf: (data: Buffer) => Promise<readonly Buffer[] | undefined>;
    // Another document's text: plain text as it is, an office file, an e-book or a web page through fileq. Undefined
    // for a format nothing here reads, or bytes that do not read as one.
    readonly readDocument: (data: Buffer, mediaType: string) => Promise<string | undefined>;
}

// A page of text a person could read on a phone is a few thousand characters; a reading many times that is a dataset,
// and still worth masking whole rather than truncating, but not worth waiting minutes for.
const READ_TIMEOUT_MS = 60_000;
// Pages drawn, at most: a provider reads no more of one PDF (Anthropic's limit). A longer one is withheld.
const PDF_PAGES = 100;
// Pages with no text layer read through OCR, at most; a longer scan is withheld rather than holding the request.
const OCR_PAGES = 20;
// The quality pages are drawn at, before what they show is painted over and they are encoded once more.
const JPEG_QUALITY = 92;

interface RunResult {
    readonly code: number | null;
    readonly stdout: string;
}

const run = (
    command: string,
    args: readonly string[],
    options: { readonly input?: Buffer; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> =>
    new Promise((resolve) => {
        const spawnOptions: SpawnOptions = { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"] };
        if (options.env !== undefined) {
            spawnOptions.env = options.env;
        }
        const child = spawnAs({ class: "toolchain" }, command, args, spawnOptions);
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
        if (options.input !== undefined) {
            child.stdin?.on("error", () => undefined);
            child.stdin?.end(options.input);
        }
    });

const meaningful = (text: string): string | undefined => (text.trim() === "" ? undefined : text);

// A directory of its own for one read, removed after: what is written there is somebody's personal data.
const inScratch = async <T>(work: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "privacy-read-"));
    try {
        return await work(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

// The pages of `in.pdf` in `dir` drawn as JPEG, in order; undefined when it does not draw or runs past PDF_PAGES.
const drawPages = async (dir: string): Promise<Buffer[] | undefined> => {
    const info = await run("pdfinfo", [join(dir, "in.pdf")]);
    const count = Number(/^Pages:\s+(\d+)/mu.exec(info.stdout)?.[1] ?? Number.NaN);
    if (info.code !== 0 || !Number.isInteger(count) || count < 1 || count > PDF_PAGES) {
        return undefined;
    }
    const drawn = await run("pdftoppm", [
        "-r",
        String(PDF_DPI),
        "-jpeg",
        "-jpegopt",
        `quality=${String(JPEG_QUALITY)}`,
        join(dir, "in.pdf"),
        join(dir, "page"),
    ]);
    if (drawn.code !== 0) {
        return undefined;
    }
    // pdftoppm pads the page number to the width of the last one, so the names sort as the pages do.
    const names = (await readdir(dir)).filter((name) => name.startsWith("page") && name.endsWith(".jpg")).toSorted();
    return names.length === count ? Promise.all(names.map(async (name) => readFile(join(dir, name)))) : undefined;
};

// What fileq reads, by the media type a file arrives under, as the extension it recognises it by.
const FILEQ_EXTENSIONS = new Map([
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
    ["application/vnd.oasis.opendocument.text", "odt"],
    ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
    ["application/vnd.oasis.opendocument.presentation", "odp"],
    ["application/rtf", "rtf"],
    ["text/rtf", "rtf"],
    ["application/epub+zip", "epub"],
    ["text/html", "html"],
    ["application/xhtml+xml", "html"],
    ["application/x-ipynb+json", "ipynb"],
]);

// Text as it is: any text/ type fileq does not read better, and JSON, XML and YAML however they are named.
const PLAIN = /^(?:text\/[\w.+-]+|application\/(?:json|xml|yaml|x-yaml|toml|csv|x-ndjson|javascript|[\w.-]+\+(?:json|xml|yaml)))$/iu;

// Bytes that are text: UTF-8 that decodes cleanly and holds no NUL.
const asText = (data: Buffer): string | undefined => {
    const text = data.toString("utf8");
    return text.includes("\u0000") || text.includes("�") ? undefined : meaningful(text);
};

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
        return image === undefined
            ? undefined
            : { width: image.rgba.width, height: image.rgba.height, lines: await reader.read(image.rgba), frames: image.frames };
    };
    // One drawn page: the text layer's lines, and the reader's for what the page shows beyond them. A page without a
    // layer (or one that does not fit its picture) is read whole, as a scan.
    const readPage = async (
        jpeg: Buffer,
        layer: Parameters<typeof layerLines>[0] | undefined,
        reader: TextReader | undefined,
    ): Promise<PdfPage | undefined> => {
        const image = await decodeImage(jpeg);
        if (image === undefined) {
            return undefined;
        }
        const { width, height } = image.rgba;
        const known = (layer === undefined ? undefined : layerLines(layer, { width, height })) ?? [];
        const read = reader === undefined ? [] : await reader.read(image.rgba, { known: known.map((line) => line.corners) });
        return { width, height, lines: readingOrder([...known, ...read]) };
    };
    return {
        ocr: async () => installed(),
        readImage,
        readPdf: async (data) =>
            inScratch(async (dir) => {
                await writeFile(join(dir, "in.pdf"), data);
                const drawn = await drawPages(dir);
                if (drawn === undefined) {
                    return undefined;
                }
                // Poppler writes UTF-8 unless told otherwise, which is what is read back here.
                const layout = await run("pdftotext", ["-bbox-layout", "-cropbox", join(dir, "in.pdf"), "-"]);
                const layers = layout.code === 0 ? textLayerOf(layout.stdout) : [];
                const reader = installed() ? await textReader() : undefined;
                const scanned = drawn.filter((_, index) => (layers[index]?.lines.length ?? 0) === 0).length;
                if (reader !== undefined && scanned > OCR_PAGES) {
                    return undefined;
                }
                const pages: PdfPage[] = [];
                for (const [index, jpeg] of drawn.entries()) {
                    const page = await readPage(jpeg, layers[index], reader);
                    if (page === undefined) {
                        return undefined;
                    }
                    pages.push(page);
                }
                return { pages, pixels: reader !== undefined };
            }),
        drawPdf: async (data) =>
            inScratch(async (dir) => {
                await writeFile(join(dir, "in.pdf"), data);
                return drawPages(dir);
            }),
        readDocument: async (data, mediaType) => {
            const type = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
            const extension = FILEQ_EXTENSIONS.get(type);
            if (extension === undefined) {
                return PLAIN.test(type) ? asText(data) : undefined;
            }
            // fileq keeps what it renders in a cache by content: here that cache is the scratch directory, so the
            // document's text is gone with it.
            return inScratch(async (dir) => {
                await writeFile(join(dir, `in.${extension}`), data);
                const read = await run("fileq", ["read", "--plain", join(dir, `in.${extension}`)], {
                    env: { ...process.env, FILEQ_HOME: join(dir, "fileq"), WORKSPACE_ROOT: "" },
                });
                return read.code === 0 ? meaningful(read.stdout) : undefined;
            });
        },
    };
};
