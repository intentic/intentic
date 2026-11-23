import { z } from "zod";

// A PERSON'S LIVE VIEW OF A CONVERSATION THAT RUNS ON A RUNNER (2026-11-23), the editor's `runners.openView`. A runner is
// another machine's sandbox container; the editor only ever talks to this sandbox, whose netd carries the view's socket
// down the runner's uplink under `/system/runner-view/<runner>/…` once this daemon redeems the one-shot ticket the answer
// carries. Each dial asks again: a ticket opens one socket, for a few seconds.

export const RunnerViewKindSchema = z.enum(["terminal", "browser-view", "desktop-view"]);
export type RunnerViewKind = z.infer<typeof RunnerViewKindSchema>;

export const RunnerOpenViewInputSchema = z.object({
    conversationId: z.string().min(1).describe("The conversation whose runner the view is of."),
    kind: RunnerViewKindSchema.describe("A terminal, a browser window's picture, or the desktop's."),
    session: z
        .string()
        .optional()
        .describe("The terminal session, the browser window (the runner's own name for it), or the desktop window; absent for the whole desktop."),
});
export type RunnerOpenViewInput = z.infer<typeof RunnerOpenViewInputSchema>;

export const RunnerViewSchema = z.object({
    runner: z.string().describe("The runner the view opens on."),
    // `/system/runner-view/<runner>/system/<view>`, on this sandbox's own address.
    path: z.string().describe("Where the socket opens on this sandbox's address."),
    query: z.string().describe("The query the socket opens with, its ticket included; add the view's own parameters to it."),
});
export type RunnerView = z.infer<typeof RunnerViewSchema>;
