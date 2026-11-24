import { readFile, stat } from "node:fs/promises";
import { errorMessage, isMissing } from "@intentic/base/errors";
import { claimedFormat, type Format } from "../formats.js";
import { checkDocx } from "./check-docx.js";
import type { CheckReport } from "./finding.js";
import { checkPdf } from "./check-pdf.js";
import { checkPptx } from "./check-pptx.js";
import { checkXlsx } from "./check-xlsx.js";

// `fileq check`'s routing: which formats have a checker, and the one read of the file every checker works from.

type Checker = (bytes: Uint8Array) => CheckReport | Promise<CheckReport>;

const CHECKERS = new Map<Format, Checker>([
    ["docx", checkDocx],
    ["pptx", checkPptx],
    ["xlsx", checkXlsx],
    ["pdf", checkPdf],
]);

export const CHECKABLE: readonly Format[] = [...CHECKERS.keys()];

// A document is read whole into memory to be checked; past this it is data to process, not a deliverable to proof.
const MAX_CHECK_BYTES = 200 * 1024 * 1024;

export type CheckOutcome =
    | { readonly kind: "checked"; readonly report: CheckReport }
    | { readonly kind: "unsupported"; readonly format: Format | undefined }
    | { readonly kind: "unreadable"; readonly reason: string };

/** Checks one file, routed by its claimed format (magic first, then the extension). */
export const checkFile = async (absPath: string): Promise<CheckOutcome> => {
    let size: number;
    try {
        size = (await stat(absPath)).size;
    } catch (cause) {
        return { kind: "unreadable", reason: isMissing(cause) ? "no such file" : errorMessage(cause) };
    }
    if (size > MAX_CHECK_BYTES) {
        return { kind: "unreadable", reason: `${Math.round(size / 1024 / 1024)} MB is over the ${MAX_CHECK_BYTES / 1024 / 1024} MB a check reads` };
    }
    const format = await claimedFormat(absPath);
    const checker = format === undefined ? undefined : CHECKERS.get(format);
    if (checker === undefined) {
        return { kind: "unsupported", format };
    }
    const report = await checker(new Uint8Array(await readFile(absPath)));
    return { kind: "checked", report };
};
