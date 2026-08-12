import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A long-lived background process the daemon runs for the extension (tmux-managed, like panel dev servers).
export const ProcessContributionSchema = z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    command: z.string().min(1),
    cwd: z.string().optional().describe("Relative to the extension checkout. Absent ⇒ the checkout root."),
    port: z.literal("auto").optional().describe("Assign a free port and inject it as PORT."),
    preview: z.boolean().optional().describe("Expose the port on a tunnelled preview hostname."),
    autoStart: z.boolean().optional().describe("Launch it on install and on daemon boot, rather than waiting to be started."),
});
export type ProcessContribution = z.infer<typeof ProcessContributionSchema>;

export const processesPoint = {
    name: "processes",
    description:
        "Long-lived background processes the daemon runs for this extension — a gateway holding a connection the daemon must not, a dev server. Managed the same way panel dev servers are, and startable and stoppable from the Extensions tab.",
    schema: z.array(ProcessContributionSchema),
} as const satisfies ContributionPoint;
