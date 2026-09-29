import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A side view the extension may register at runtime (api.sideViews.register): something it can show in the editor's side
// panel for one input (a CI run, a workflow run), beside whichever section the reader is in, and move into its own view
// on request. The host owns the panel and the tab; the extension answers what the tab says and draws its body.
export const SideViewContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z
        .string()
        .min(1)
        .describe(
            "What one of these is called (\"CI run\"), shown in the install dialog and on a tab whose own title could not be read. Each tab's title is the extension's to say for the thing it shows.",
        ),
    // Whether this side view may take links the chat renders (SideViewRegistration.claim): a link it recognises opens
    // beside the chat instead of in a new browser tab. Declared, like a badge, because it changes what the reader's
    // click does; absent, the host never asks it.
    links: z
        .boolean()
        .optional()
        .describe(
            "Allow this side view to take links the chat renders: a link it recognises (its registration's `claim`) opens beside the chat instead of in a new browser tab. Declared because it changes what the reader's click does; leave it out and the host never asks.",
        )
        .meta({ power: { key: "side-view-links:${id}", sentence: 'opens links it recognises as "${label}" beside the chat' } }),
})
    .meta({ power: { key: "side-view:${id}", sentence: 'shows "${label}" in the side panel' } });
export type SideViewContribution = z.infer<typeof SideViewContributionSchema>;

export const sideViewsPoint = {
    name: "sideViews",
    description:
        "Things this extension can show in the editor's side panel, one input at a time, beside whatever the reader is doing. Each entry reserves an id; the extension supplies the component with api.sideViews.register and opens one with api.sideViews.open, and the host refuses any id this list does not cover.",
    schema: z.array(SideViewContributionSchema),
} as const satisfies ContributionPoint;
