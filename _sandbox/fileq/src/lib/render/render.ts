import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { toolOutDir } from "@intentic/agent-cli/env";
import { STATE_DIR } from "@intentic/constants";
import { getDocumentProxy } from "unpdf";
import { relPathIn } from "../derive.js";
import { claimedFormat, type Format } from "../formats.js";
import { sha256OfFile } from "../sidecar.js";
import { ConvertFailed, listDir, office, rasterizer, toPdf, toPngs } from "./convert.js";
import { BadPages, pagesWithin, type PageRange } from "./pages.js";

// `fileq render`: a document's pages (a deck's slides) as PNG files an agent can look at with its image reader, the
// check that a structural lint cannot make. Office formats go through LibreOffice to PDF first, so what comes out is
// LibreOffice's layout: close to Office's, not identical where a font is substituted.
// By default the images land in a mirrored folder beside the sidecars, keyed by the document's hash: rendering an
// unchanged document again answers from there, and a changed one clears the old pages before drawing the new.

export const RENDERED_DIR = `${STATE_DIR}/local/cache/rendered`;

// Without --pages, a long document renders its first pages only: each image costs a read, and the first ones answer
// most "does it look right".
export const DEFAULT_PAGE_CAP = 20;
export const DEFAULT_SIZE = 1600;

const VIA_OFFICE: ReadonlySet<Format> = new Set(["docx", "pptx", "xlsx", "odt", "ods", "odp", "rtf"]);
const SLIDES: ReadonlySet<Format> = new Set(["pptx", "odp"]);

export class NotRenderable extends Error {}

export interface RenderRequest {
    readonly absPath: string;
    /** Undefined renders from the first page up to DEFAULT_PAGE_CAP. */
    readonly pages: readonly PageRange[] | undefined;
    /** Undefined writes to the default folder, with its reuse and clean-up; a given folder is written as asked. */
    readonly outDir: string | undefined;
    /** The longest side of each image, in pixels. */
    readonly size: number;
}

export interface RenderedPage {
    readonly page: number;
    readonly path: string;
}

export interface RenderResult {
    readonly format: Format;
    /** `slide` for a presentation, `page` for everything else. */
    readonly unit: "slide" | "page";
    readonly total: number;
    readonly images: RenderedPage[];
    readonly outDir: string;
    /** Whether every image came from an earlier render of the same bytes. */
    readonly reused: boolean;
    readonly notes: string[];
}

interface Stamp {
    readonly sha256: string;
    readonly size: number;
    readonly total: number;
}

const STAMP_FILE = ".fileq-render.json";

/** The default folder for a document's images: mirrored under the workspace's cache, or under fileq's own home outside one. */
export const defaultOutDir = (absPath: string, workspaceRoot: string | undefined): string => {
    const relPath = workspaceRoot === undefined ? undefined : relPathIn(workspaceRoot, absPath);
    if (workspaceRoot !== undefined && relPath !== undefined) {
        return join(workspaceRoot, RENDERED_DIR, relPath);
    }
    const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 8);
    return join(toolOutDir("fileq"), "rendered", `${basename(absPath).toLowerCase().replaceAll(/[^a-z0-9.]+/g, "-")}-${hash}`);
};

const readStamp = async (dir: string): Promise<Stamp | undefined> => {
    try {
        const parsed: Partial<Stamp> = JSON.parse(await readFile(join(dir, STAMP_FILE), "utf8"));
        return parsed.sha256 === undefined || parsed.size === undefined || parsed.total === undefined ? undefined : { sha256: parsed.sha256, size: parsed.size, total: parsed.total };
    } catch {
        // allow(silent-catch): no earlier render, or a stamp someone edited; either way the answer is to render afresh.
        return undefined;
    }
};

// Removes the images an earlier render of different bytes left, and nothing else in the folder.
const clearImages = async (dir: string): Promise<void> => {
    const names = await listDir(dir);
    await Promise.all(names.filter((name) => /^(?:slide|page)-\d+\.png$/.test(name)).map((name) => rm(join(dir, name), { force: true })));
};

// Outside the sandbox the rendered tree sits inside somebody's repository; like the sidecars, it ignores itself.
const ignoreInGit = async (workspaceRoot: string | undefined, outDir: string): Promise<void> => {
    if (workspaceRoot === undefined || !outDir.startsWith(join(workspaceRoot, RENDERED_DIR))) {
        return;
    }
    try {
        await writeFile(join(workspaceRoot, RENDERED_DIR, ".gitignore"), "# fileq's rendered pages; regenerated on demand.\n*\n", { flag: "wx" });
    } catch {
        // allow(silent-catch): already there (an owner's own edit wins), or unwritable, which costs git noise and nothing else.
    }
};

const pageCount = async (pdfPath: string): Promise<number> => {
    try {
        const pdf = await getDocumentProxy(new Uint8Array(await readFile(pdfPath)));
        return pdf.numPages;
    } catch (cause) {
        const locked = cause instanceof Error && cause.name === "PasswordException";
        throw new ConvertFailed(locked ? "the PDF is password-protected" : "the PDF cannot be read");
    }
};

const formatOf = async (absPath: string): Promise<Format> => {
    const format = await claimedFormat(absPath);
    if (format === "pdf" || (format !== undefined && VIA_OFFICE.has(format))) {
        return format;
    }
    if (format === "image") {
        throw new NotRenderable("an image is already pixels: Read it directly");
    }
    throw new NotRenderable(`fileq render draws pdf, docx, pptx, xlsx, odt, odp, ods and rtf; this is ${format ?? "none of them"}`);
};

// The pages to draw: the ones asked for, or the first DEFAULT_PAGE_CAP; asking only for pages past the end is a mistake
// worth stopping on, since the agent is counting slides the deck does not have.
const choosePages = (request: RenderRequest, total: number, unit: string, notes: string[]): number[] => {
    if (request.pages === undefined) {
        const pages = pagesWithin([{ from: 1, to: DEFAULT_PAGE_CAP }], total);
        if (total > DEFAULT_PAGE_CAP) {
            notes.push(`drew the first ${DEFAULT_PAGE_CAP} of ${total} ${unit}s: pass --pages ${DEFAULT_PAGE_CAP + 1}-${total} for the rest`);
        }
        return pages;
    }
    const pages = pagesWithin(request.pages, total);
    if (pages.length === 0) {
        throw new BadPages(`the document has ${total} ${unit}${total === 1 ? "" : "s"}; --pages names none of them`);
    }
    const asked = request.pages.some((range) => (range.to ?? range.from) > total);
    if (asked) {
        notes.push(`the document has ${total} ${unit}${total === 1 ? "" : "s"}; drew the ones --pages named within that`);
    }
    return pages;
};

/** Renders the requested pages of a document to PNG files. Throws ToolMissing, NotRenderable, ConvertFailed or BadPages. */
export const renderDocument = async (request: RenderRequest, workspaceRoot: string | undefined): Promise<RenderResult> => {
    const format = await formatOf(request.absPath);
    const unit = SLIDES.has(format) ? "slide" : "page";
    const tool = rasterizer();
    const binary = format === "pdf" ? undefined : office(format);
    const outDir = request.outDir ?? defaultOutDir(request.absPath, workspaceRoot);
    const notes: string[] = [];
    const sha256 = await sha256OfFile(request.absPath);
    const cached = request.outDir === undefined ? await readStamp(outDir) : undefined;
    const current = cached !== undefined && cached.sha256 === sha256 && cached.size === request.size;
    if (current) {
        const pages = choosePages(request, cached.total, unit, notes);
        const existing = new Set(await listDir(outDir));
        if (pages.every((page) => existing.has(`${unit}-${page}.png`))) {
            return { format, unit, total: cached.total, images: pages.map((page) => ({ page, path: join(outDir, `${unit}-${page}.png`) })), outDir, reused: true, notes };
        }
        notes.length = 0;
    }
    const work = await mkdtemp(join(tmpdir(), "fileq-render-"));
    try {
        const pdf = binary === undefined ? request.absPath : await toPdf(binary, request.absPath, format, work);
        const total = await pageCount(pdf);
        const pages = choosePages(request, total, unit, notes);
        const raster = join(work, "png");
        await mkdir(raster, { recursive: true });
        const drawn = await toPngs(tool, pdf, pages, request.size, raster);
        await mkdir(outDir, { recursive: true });
        await ignoreInGit(workspaceRoot, outDir);
        if (request.outDir === undefined && !current) {
            await clearImages(outDir);
        }
        const images: RenderedPage[] = [];
        for (const page of pages) {
            const from = drawn.get(page);
            if (from !== undefined) {
                const path = join(outDir, `${unit}-${page}.png`);
                await copyFile(from, path);
                images.push({ page, path });
            }
        }
        if (images.length < pages.length) {
            notes.push(`${pages.length - images.length} of the ${unit}s asked for drew nothing`);
        }
        if (request.outDir === undefined) {
            await writeFile(join(outDir, STAMP_FILE), `${JSON.stringify({ sha256, size: request.size, total } satisfies Stamp)}\n`);
        }
        return { format, unit, total, images, outDir, reused: false, notes };
    } finally {
        await rm(work, { recursive: true, force: true });
    }
};
