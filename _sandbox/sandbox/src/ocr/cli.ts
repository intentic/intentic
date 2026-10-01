#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ocrInstalled, ocrModelDir } from "./models.js";

// `ocr <image>...`: the text on each image, read on this machine by PaddleOCR's PP-OCRv6, the reader the privacy shield
// checks images with. One line of output per row of text, in reading order, a tab between the pieces of a row (a label
// and its value, a table's cells); a form feed line between images, an image that could not be read leaving its part
// empty so the ones after it keep their places. Nothing leaves the machine, which is the point: an agent can read a
// screenshot of personal data without sending its pixels to the model. fileq's OCR tier reads scanned PDF pages through
// it, asking `ocr --check` first: the command is on every image, its models only where the `privacy` pack is. Exit 2
// without the models, 1 when an image could not be read.

const USAGE = `ocr — read the text on images, on this machine (PaddleOCR PP-OCRv6)

  ocr <image>...   prints each image's text in reading order, one row per line with a tab between its pieces, and a
                   form feed line between images
  ocr --check      exits 0 when the models are installed and images can be read, 2 when they are not

Reads PNG, JPEG, WebP, GIF, TIFF and AVIF. Nothing is sent anywhere.`;

const NOT_INSTALLED = (): string =>
    `ocr: the PP-OCRv6 models are not installed at ${ocrModelDir()}. They come with the privacy image pack: run \`environment propose privacy --pack\` and rebuild once the owner approves.\n`;

const main = async (paths: readonly string[]): Promise<number> => {
    if (paths.length === 0 || paths.includes("--help") || paths.includes("-h")) {
        process.stdout.write(`${USAGE}\n`);
        return paths.length === 0 ? 2 : 0;
    }
    if (!ocrInstalled()) {
        process.stderr.write(NOT_INSTALLED());
        return 2;
    }
    if (paths.includes("--check")) {
        return 0;
    }
    // Loaded only once there is something to read: the runtime and the image decoder are native libraries.
    const [{ loadTextReader, pageText }, { decodeImage }] = await Promise.all([import("./paddle-ocr.js"), import("./raster.js")]);
    const reader = await loadTextReader(undefined, (message, error) => process.stderr.write(`ocr: ${message}: ${String(error)}\n`));
    if (reader === undefined) {
        return 2;
    }
    let failed = false;
    for (const [index, path] of paths.entries()) {
        const image = await decodeImage(await readFile(path).catch(() => Buffer.alloc(0)));
        if (index > 0) {
            process.stdout.write("\f\n");
        }
        if (image === undefined) {
            process.stderr.write(`ocr: ${path} is not an image this reader can decode\n`);
            failed = true;
            continue;
        }
        const lines = await reader.read(image.rgba);
        process.stdout.write(lines.length === 0 ? "" : `${pageText(lines)}\n`);
    }
    return failed ? 1 : 0;
};

process.exitCode = await main(process.argv.slice(2));
