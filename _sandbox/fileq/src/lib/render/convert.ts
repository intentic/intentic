import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { errorMessage, isMissing } from "@intentic/base/errors";
import { onPath } from "../tools.js";
import { runsOf } from "./pages.js";

// The two external steps of `fileq render`: an office document to PDF through LibreOffice, and PDF pages to PNG
// through poppler's pdftoppm or MuPDF's mutool. fileq carries no renderer of its own: a faithful one is LibreOffice-sized,
// and a missing tool is named with what installs it rather than papered over with a worse picture.

const run = promisify(execFile);

// A first conversion also builds LibreOffice's profile, which is most of its time; a long deck takes longer still.
const CONVERT_TIMEOUT_MS = 180_000;
const RASTER_TIMEOUT_MS = 120_000;

export class ToolMissing extends Error {}
export class ConvertFailed extends Error {}

export type Rasterizer = "pdftoppm" | "mutool";

/** A folder's entries; none when it does not exist (yet, or because a tool never wrote it). */
export const listDir = async (dir: string): Promise<string[]> => {
    try {
        return await readdir(dir);
    } catch (cause) {
        if (isMissing(cause)) {
            return [];
        }
        throw cause;
    }
};

// In an Intentic sandbox (its `environment` command is on PATH) the tools are the opt-in `office` image pack, which an
// agent asks the owner for by name; anywhere else they are ordinary packages.
const OFFICE_PACK = 'ask the owner for the office image pack (LibreOffice and poppler) with `environment propose office --pack --why "to look at the document I made"`: it arrives with the next rebuild; until then say the document was checked but not seen';

const inSandbox = (): boolean => onPath("environment");

/** The rasterizer on PATH, poppler's first; throws ToolMissing with what to install when there is none. */
export const rasterizer = (): Rasterizer => {
    if (onPath("pdftoppm")) {
        return "pdftoppm";
    }
    if (onPath("mutool")) {
        return "mutool";
    }
    const remedy = inSandbox() ? OFFICE_PACK : "install one (Debian/Ubuntu: apt-get install poppler-utils)";
    throw new ToolMissing(`rendering pages needs pdftoppm (poppler-utils) or mutool (mupdf-tools) on PATH, and neither is here: ${remedy}`);
};

/** LibreOffice's binary on PATH; throws ToolMissing with what to install when there is none. */
export const office = (format: string): string => {
    for (const name of ["soffice", "libreoffice"]) {
        if (onPath(name)) {
            return name;
        }
    }
    const remedy = inSandbox()
        ? OFFICE_PACK
        : "install it (Debian/Ubuntu: apt-get install libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui), or export the file to PDF yourself and render that";
    throw new ToolMissing(`rendering a ${format} needs LibreOffice (soffice) on PATH to lay it out, and it is not here: ${remedy}`);
};

// Impress leaves hidden slides out of a PDF by default, which would shift every later page off its slide number.
const IMPRESS_PDF = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}';
const pdfFilter = (format: string): string => (format === "pptx" || format === "odp" ? IMPRESS_PDF : "pdf");

/**
 * Converts an office document to PDF in `workDir` and answers the PDF's path. Each run gets its own LibreOffice
 * profile, so two conversions at once never meet over a lock file, and none of them touches the user's own profile.
 */
export const toPdf = async (binary: string, absPath: string, format: string, workDir: string): Promise<string> => {
    const outDir = join(workDir, "pdf");
    const args = [
        "--headless",
        "--norestore",
        "--nologo",
        "--nolockcheck",
        `-env:UserInstallation=file://${join(workDir, "profile")}`,
        "--convert-to",
        pdfFilter(format),
        "--outdir",
        outDir,
        absPath,
    ];
    let output = "";
    try {
        const result = await run(binary, args, { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
        output = `${result.stdout}${result.stderr}`;
    } catch (cause) {
        throw new ConvertFailed(`LibreOffice could not convert it: ${errorMessage(cause).split("\n").slice(0, 3).join(" ")}`);
    }
    // LibreOffice names the PDF after the source and exits 0 even when it wrote nothing, so the file is the answer.
    const expected = `${basename(absPath, extname(absPath))}.pdf`;
    const written = await listDir(outDir);
    if (!written.includes(expected)) {
        const said = output.trim().split("\n").slice(-2).join(" ");
        throw new ConvertFailed(`LibreOffice wrote no PDF${said === "" ? "" : ` (it said: ${said})`}; the file may be damaged or password-protected`);
    }
    return join(outDir, expected);
};

/**
 * Rasterizes the given pages of `pdf` into `outDir`, each fitted into a `size`-pixel square, and answers each page's
 * PNG path. The rasterizers name their files differently; the page number is read back off the name either way.
 */
export const toPngs = async (tool: Rasterizer, pdf: string, pages: readonly number[], size: number, outDir: string): Promise<Map<number, string>> => {
    const prefix = join(outDir, "p");
    try {
        if (tool === "pdftoppm") {
            for (const [first, last] of runsOf(pages)) {
                await run("pdftoppm", ["-png", "-scale-to", String(size), "-f", String(first), "-l", String(last), pdf, prefix], { timeout: RASTER_TIMEOUT_MS });
            }
        } else {
            await run("mutool", ["draw", "-q", "-F", "png", "-w", String(size), "-h", String(size), "-o", `${prefix}-%d.png`, pdf, pages.join(",")], {
                timeout: RASTER_TIMEOUT_MS,
            });
        }
    } catch (cause) {
        throw new ConvertFailed(`${tool} could not draw the pages: ${errorMessage(cause).split("\n").slice(0, 3).join(" ")}`);
    }
    const drawn = new Map<number, string>();
    for (const name of await readdir(outDir)) {
        const match = /^p-0*(\d+)\.png$/.exec(name);
        if (match !== null) {
            drawn.set(Number(match[1]), join(outDir, name));
        }
    }
    return drawn;
};
