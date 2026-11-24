// `fileq render` end to end in a temp workspace: real pdftoppm (or mutool) drawing real PNGs, a stand-in LibreOffice
// whose only job is to prove the conversion's command line and output pickup, and the real LibreOffice where the
// machine has it. Driven through the same `run(app, …)` seam cli.ts calls.
import { STATE_DIR } from "@intentic/constants";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCli, type CliOutcome } from "@intentic/agent-cli/testing";
import { requires } from "@intentic/testing/requires";
import { imageSize } from "image-size";
import { app } from "./app.js";
import { onPath } from "./lib/tools.js";
import { deckBytes, pdfPagesBytes, pngBytes, textBox } from "./testing.js";

let root: string;
let stubs: string;
const originalPath = process.env["PATH"] ?? "";

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fileq-render-"));
    stubs = mkdtempSync(join(tmpdir(), "fileq-render-bin-"));
    process.env["WORKSPACE_ROOT"] = root;
});
afterAll(() => {
    delete process.env["WORKSPACE_ROOT"];
    process.env["PATH"] = originalPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(stubs, { recursive: true, force: true });
});
afterEach(() => {
    process.env["PATH"] = originalPath;
});

const fileq = (...args: string[]): Promise<CliOutcome> => captureCli(app, args);

const pagesPdf = (count: number): Uint8Array =>
    pdfPagesBytes(Array.from({ length: count }, (_, index) => ({ content: `BT /F1 24 Tf 72 700 Td (Page ${index + 1}) Tj ET` })));

const renderedDir = (relPath: string): string => join(root, `${STATE_DIR}/local/cache/rendered`, relPath);

const sizeOf = (path: string): { width?: number; height?: number } => imageSize(new Uint8Array(readFileSync(path)));

const raster = requires(onPath("pdftoppm") || onPath("mutool"), "pdftoppm (poppler-utils) or mutool on PATH");

describe("pdf", () => {
    test.skipIf(!raster.runs)(raster.title("draws each page to the workspace's rendered folder and prints the paths"), async () => {
        writeFileSync(join(root, "report.pdf"), pagesPdf(3));
        const { out, exitCode } = await fileq("render", join(root, "report.pdf"));
        expect(exitCode).toBe(0);
        const paths = [1, 2, 3].map((page) => join(renderedDir("report.pdf"), `page-${page}.png`));
        expect(out).toBe(`fileq: report.pdf · pdf · 3 pages · drew pages 1-3 · rendered\n${paths.join("\n")}\n`);
        // US Letter fitted into the default 1600 px: the long side is the height.
        expect(sizeOf(paths[0] ?? "")).toMatchObject({ height: 1600 });
        expect(readFileSync(join(root, ".intentic/local/cache/rendered/.gitignore"), "utf8")).toBe(
            "# fileq's rendered pages; regenerated on demand.\n*\n",
        );
    });

    test.skipIf(!raster.runs)(
        raster.title("an unchanged document answers from the last render; a changed one clears the pages it no longer has"),
        async () => {
            writeFileSync(join(root, "memo.pdf"), pagesPdf(3));
            await fileq("render", join(root, "memo.pdf"));
            const again = await fileq("render", join(root, "memo.pdf"), "--pages", "2");
            expect(again.out).toBe(
                `fileq: memo.pdf · pdf · 3 pages · drew page 2 · unchanged since the last render\n${join(renderedDir("memo.pdf"), "page-2.png")}\n`,
            );
            writeFileSync(join(root, "memo.pdf"), pagesPdf(1));
            const changed = await fileq("render", join(root, "memo.pdf"));
            expect(changed.out).toContain("1 page · drew page 1 · rendered");
            expect(existsSync(join(renderedDir("memo.pdf"), "page-1.png"))).toBe(true);
            expect(existsSync(join(renderedDir("memo.pdf"), "page-3.png"))).toBe(false);
        },
    );

    test.skipIf(!raster.runs)(raster.title("--pages, --out and --size shape what is drawn and where"), async () => {
        writeFileSync(join(root, "long.pdf"), pagesPdf(4));
        const out = join(root, "shots");
        const { out: printed, exitCode } = await fileq("render", join(root, "long.pdf"), "--pages", "2,4", "--out", out, "--size", "400");
        expect(exitCode).toBe(0);
        expect(printed).toBe(
            `fileq: long.pdf · pdf · 4 pages · drew pages 2, 4 · rendered\n${join(out, "page-2.png")}\n${join(out, "page-4.png")}\n`,
        );
        expect(sizeOf(join(out, "page-4.png"))).toMatchObject({ height: 400 });
        expect(existsSync(join(out, ".fileq-render.json"))).toBe(false);
    });

    test.skipIf(!raster.runs)(raster.title("asking only for pages past the end stops with the page count"), async () => {
        writeFileSync(join(root, "short.pdf"), pagesPdf(2));
        const { out, exitCode } = await fileq("render", join(root, "short.pdf"), "--pages", "5-9");
        expect(exitCode).toBe(2);
        expect(out).toBe(`fileq: cannot render ${join(root, "short.pdf")}: the document has 2 pages; --pages names none of them\n`);
    });

    test.skipIf(!raster.runs)(raster.title("a long document draws its first twenty pages and says how to get the rest"), async () => {
        writeFileSync(join(root, "book.pdf"), pagesPdf(22));
        const { out } = await fileq("render", join(root, "book.pdf"), "--size", "100");
        expect(out).toContain("note: drew the first 20 of 22 pages: pass --pages 21-22 for the rest\n");
        expect(
            out
                .trim()
                .split("\n")
                .filter((line) => line.endsWith(".png")),
        ).toHaveLength(20);
    });
});

describe("tools", () => {
    test("with no rasterizer on PATH it names what to install and exits 2", async () => {
        writeFileSync(join(root, "plain.pdf"), pagesPdf(1));
        process.env["PATH"] = "/nonexistent";
        const { out, exitCode } = await fileq("render", join(root, "plain.pdf"));
        expect(exitCode).toBe(2);
        expect(out).toContain("rendering pages needs pdftoppm (poppler-utils) or mutool (mupdf-tools) on PATH, and neither is here");
    });

    test("in an Intentic sandbox (its environment command on PATH) it prints the command that asks for the office pack", async () => {
        writeFileSync(join(root, "sandboxed.pdf"), pagesPdf(1));
        const sandbox = join(stubs, "sandbox-bin");
        mkdirSync(sandbox, { recursive: true });
        writeFileSync(join(sandbox, "environment"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(sandbox, "environment"), 0o755);
        process.env["PATH"] = sandbox;
        const { out, exitCode } = await fileq("render", join(root, "sandboxed.pdf"));
        expect(exitCode).toBe(2);
        expect(out).toContain(
            'neither is here: ask the owner for the office image pack (LibreOffice and poppler) with `environment propose office --pack --why "to look at the document I made"`',
        );
    });

    test("an office document with no LibreOffice on PATH says so and exits 2", async () => {
        writeFileSync(join(root, "deck.pptx"), deckBytes({ slides: [{ drawings: [textBox("Title", { x: 1, y: 1, w: 6, h: 1 }, ["Hello"])] }] }));
        const onlyRaster = join(stubs, "raster-only");
        mkdirSync(onlyRaster, { recursive: true });
        writeFileSync(join(onlyRaster, "pdftoppm"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(onlyRaster, "pdftoppm"), 0o755);
        process.env["PATH"] = onlyRaster;
        const { out, exitCode } = await fileq("render", join(root, "deck.pptx"));
        expect(exitCode).toBe(2);
        expect(out).toContain("rendering a pptx needs LibreOffice (soffice) on PATH to lay it out, and it is not here");
    });

    test("an image is not rendered: it is already pixels", async () => {
        writeFileSync(join(root, "photo.png"), pngBytes());
        const { out, exitCode } = await fileq("render", join(root, "photo.png"));
        expect(exitCode).toBe(1);
        expect(out).toContain("an image is already pixels: Read it directly");
    });
});

describe("office documents", () => {
    // A stand-in soffice: records its arguments and "converts" by copying a prepared PDF to where LibreOffice would
    // write it, named after the source. The rasterizer after it is the real one.
    const stubOffice = (): string => {
        const bin = join(stubs, "office");
        mkdirSync(bin, { recursive: true });
        writeFileSync(
            join(bin, "soffice"),
            [
                "#!/bin/sh",
                'printf "%s\\n" "$@" > "$FILEQ_STUB_ARGS"',
                'out=""; prev=""; last=""',
                'for arg in "$@"; do if [ "$prev" = "--outdir" ]; then out="$arg"; fi; prev="$arg"; last="$arg"; done',
                'stem=$(basename "$last"); stem="${stem%.*}"',
                'mkdir -p "$out" && cp "$FILEQ_STUB_PDF" "$out/$stem.pdf"',
                "",
            ].join("\n"),
        );
        chmodSync(join(bin, "soffice"), 0o755);
        return bin;
    };

    test.skipIf(!raster.runs)(
        raster.title("a deck converts through LibreOffice with hidden slides kept, its own profile, and counts in slides"),
        async () => {
            const argsFile = join(stubs, "args.txt");
            writeFileSync(join(stubs, "converted.pdf"), pagesPdf(2));
            process.env["FILEQ_STUB_ARGS"] = argsFile;
            process.env["FILEQ_STUB_PDF"] = join(stubs, "converted.pdf");
            process.env["PATH"] = `${stubOffice()}:${originalPath}`;
            try {
                writeFileSync(join(root, "talk.pptx"), deckBytes({ slides: [{ drawings: [] }, { drawings: [], hidden: true }] }));
                const { out, exitCode } = await fileq("render", join(root, "talk.pptx"));
                expect(exitCode).toBe(0);
                expect(out).toContain("fileq: talk.pptx · pptx · 2 slides · drew slides 1-2 · rendered\n");
                expect(out).toContain(join(renderedDir("talk.pptx"), "slide-2.png"));
                const args = readFileSync(argsFile, "utf8").split("\n");
                expect(args.slice(0, 4)).toEqual(["--headless", "--norestore", "--nologo", "--nolockcheck"]);
                expect(args[4]).toMatch(/^-env:UserInstallation=file:\/\/.*\/profile$/);
                expect(args.slice(5, 7)).toEqual(["--convert-to", 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}']);
                expect(args.at(-2)).toBe(join(root, "talk.pptx"));
            } finally {
                delete process.env["FILEQ_STUB_ARGS"];
                delete process.env["FILEQ_STUB_PDF"];
            }
        },
    );

    test("a conversion that writes nothing is exit 1 with LibreOffice's own words", async () => {
        const bin = join(stubs, "silent");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "soffice"), "#!/bin/sh\necho 'Error: source file could not be loaded'\n");
        writeFileSync(join(bin, "pdftoppm"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, "soffice"), 0o755);
        chmodSync(join(bin, "pdftoppm"), 0o755);
        process.env["PATH"] = `${bin}:/usr/bin:/bin`;
        writeFileSync(join(root, "broken.docx"), "not really a document");
        const { out, exitCode } = await fileq("render", join(root, "broken.docx"));
        expect(exitCode).toBe(1);
        expect(out).toContain(
            "LibreOffice wrote no PDF (it said: Error: source file could not be loaded); the file may be damaged or password-protected",
        );
    });

    const office = requires(onPath("soffice") && (onPath("pdftoppm") || onPath("mutool")), "LibreOffice (soffice) and a rasterizer on PATH", {
        absentOnCi: "the CI image carries poppler but not LibreOffice (about 340 MB); the stand-in above covers the command line",
    });
    // A hang bound, not a measurement: a first conversion builds a fresh LibreOffice profile, seconds on an idle machine.
    test.skipIf(!office.runs)(
        office.title("the real LibreOffice draws a deck built from its parts, one PNG a slide"),
        async () => {
            writeFileSync(
                join(root, "real.pptx"),
                deckBytes({
                    slides: [
                        { drawings: [textBox("Title 1", undefined, ["Quarterly results"], { ph: { type: "title" } })] },
                        { drawings: [textBox("Body", { x: 1, y: 1, w: 6, h: 2 }, ["Revenue up 4%"])] },
                    ],
                }),
            );
            const { out, exitCode } = await fileq("render", join(root, "real.pptx"), "--size", "640");
            expect(exitCode).toBe(0);
            expect(out).toContain("fileq: real.pptx · pptx · 2 slides · drew slides 1-2 · rendered\n");
            // 16:9 fitted into 640 px: the long side is the width, the short one 360 give or take the rasterizer's rounding.
            const size = sizeOf(join(renderedDir("real.pptx"), "slide-1.png"));
            expect(size.width).toBe(640);
            expect(Math.round((size.height ?? 0) / 10)).toBe(36);
        },
        180_000,
    );
});
