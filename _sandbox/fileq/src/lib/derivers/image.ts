import { readFile } from "node:fs/promises";
import { parse as parseExif } from "exifr";
import { imageSize } from "image-size";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Images, the deterministic tier: dimensions, format, and the EXIF facts a camera or an editor left behind.
 * No caption — describing pixels takes a vision model, which costs money or a GPU, and this tier is the one
 * that runs unasked in the background on every file that lands. The sidecar says so explicitly, because "no
 * description" must read as "not generated", never as "nothing to see". Models with vision read the image
 * itself; this shadow exists for search and for the providers that cannot. */

// The EXIF fields worth a line each, in the order they help: what took it, when, where, how it is oriented.
const EXIF_LINES: readonly { readonly label: string; readonly keys: readonly string[] }[] = [
    { label: "Camera", keys: ["Make", "Model"] },
    { label: "Taken", keys: ["DateTimeOriginal", "CreateDate"] },
    { label: "Software", keys: ["Software"] },
    { label: "Orientation", keys: ["Orientation"] },
];

export const imageDeriver: Deriver = {
    name: "image",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const bytes = await readFile(absPath);
        const lines: string[] = [];
        try {
            const dims = imageSize(bytes);
            lines.push(`- Format: ${dims.type ?? "unknown"}`, `- Dimensions: ${dims.width}×${dims.height}`);
        } catch {
            lines.push("- Dimensions: unreadable");
        }
        const exif = (await parseExif(bytes).catch(() => undefined)) as Record<string, unknown> | undefined;
        if (exif !== undefined) {
            for (const { label, keys } of EXIF_LINES) {
                const parts = keys.map((key) => exif[key]).filter((value) => value !== undefined && value !== "");
                if (parts.length > 0) {
                    lines.push(`- ${label}: ${parts.map((part) => (part instanceof Date ? part.toISOString() : String(part))).join(" ")}`);
                }
            }
            if (typeof exif["latitude"] === "number" && typeof exif["longitude"] === "number") {
                lines.push(`- GPS: ${exif["latitude"].toFixed(5)}, ${exif["longitude"].toFixed(5)}`);
            }
        }
        return {
            markdown: lines.join("\n"),
            notes: ["no visual description: image captioning is a later, model-backed tier — vision models should Read the image itself"],
        };
    },
};
