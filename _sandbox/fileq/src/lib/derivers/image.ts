import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { imageSize } from "image-size";
import type { DerivedDoc, Deriver } from "./deriver.js";

// exifr is CommonJS despite its ESM build; import { parse } type-checks but throws at load, so require it.
const { parse: parseExif } = createRequire(import.meta.url)("exifr") as typeof import("exifr");

// Deterministic tier: dimensions, format, and EXIF facts left behind; no caption, since describing pixels needs a
// vision model.
// The sidecar says explicitly that no description was generated, so that reads as "not generated", not "nothing to
// see".

// EXIF fields worth a line each, in the order they help: what took it, when, where, how it's oriented.
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
