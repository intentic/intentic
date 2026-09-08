import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A custom file viewer the extension may register at runtime; the host resolves an open file to it by extension,
// fetches the content, and renders the registered component. The host owns the fetch and open-file lifecycle and the
// daemon credentials; the extension only renders.
export const ViewerContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    extensions: z
        .array(z.string().regex(/^[a-z0-9]+$/))
        .min(1)
        .describe('Bare file extensions, no dot: e.g. ["docx", "xlsx"].'),
    // What the host hands the extension:
    // text - decoded utf8, for a format that is text (svg, a subtitle track, a notebook).
    // blob - the whole file in memory, for a format that must be parsed end to end (a .docx, a spreadsheet). Bounded by
    // the daemon's raw-read cap.
    // url - a streaming URL the component points an element at, for anything range-read rather than parsed (audio,
    // video); the host mints the credential and keeps it out of the extension.
    fetch: z
        .enum(["text", "blob", "url"])
        .describe(
            "How much of the file the host hands you. `text` for a format that is text (svg, a subtitle track). `blob` for one that must be parsed end to end before any of it shows (a .docx, a spreadsheet), bounded by the daemon's raw-read cap. `url` for anything range-read rather than parsed (audio, video): your component gets a streaming URL to point an element at, never the bytes.",
        ),
});
export type ViewerContribution = z.infer<typeof ViewerContributionSchema>;

export const viewersPoint = {
    name: "viewers",
    description:
        "File formats this extension can render. The host resolves an opened file to your viewer by its extension, fetches the content, and renders your component with it: you keep none of the fetch lifecycle and none of the daemon credentials.",
    schema: z.array(ViewerContributionSchema),
} as const satisfies ContributionPoint;
