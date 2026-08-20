import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

/* A custom file viewer the extension may register at runtime (api.viewers.register): the host resolves an open
 * file to this viewer by extension, gets its content, and renders the registered component with it, the host
 * keeps the fetch + open-file lifecycle and the daemon credentials; the extension only renders. This is the
 * non-sidebar contribution point. */
export const ViewerContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    extensions: z
        .array(z.string().regex(/^[a-z0-9]+$/))
        .min(1)
        .describe('Bare file extensions, no dot — e.g. ["docx", "xlsx"].'),
    /* `fetch` is how much of the file the host puts in the extension's hands, and it is a real choice:
     *   text, decoded utf8 (`text` prop). For a format that IS text: svg, a subtitle track, a notebook.
     *   blob, the whole file in memory (`blob` prop). For a format that must be parsed end to end before any of
     *          it can be shown: a .docx, a spreadsheet. Bounded by the daemon's raw-read cap.
     *   url , a streaming URL the component points an element at (`src` prop), never the bytes. For anything
     *          RANGE-READ rather than parsed: audio and video, where the file may be gigabytes and the player
     *          wants the header, the index and the seconds around the playhead, not the file. The host mints
     *          the credential on that URL and keeps it out of the extension.
     */
    fetch: z
        .enum(["text", "blob", "url"])
        .describe(
            "How much of the file the host hands you. `text` for a format that is text (svg, a subtitle track). `blob` for one that must be parsed end to end before any of it shows (a .docx, a spreadsheet) — bounded by the daemon's raw-read cap. `url` for anything range-read rather than parsed (audio, video): your component gets a streaming URL to point an element at, never the bytes.",
        ),
});
export type ViewerContribution = z.infer<typeof ViewerContributionSchema>;

export const viewersPoint = {
    name: "viewers",
    description:
        "File formats this extension can render. The host resolves an opened file to your viewer by its extension, fetches the content, and renders your component with it — you keep none of the fetch lifecycle and none of the daemon credentials.",
    schema: z.array(ViewerContributionSchema),
} as const satisfies ContributionPoint;
