import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A starting point in the automation composer: a trigger, a prompt written for that trigger's payload, and any guard
// that makes it safe to leave on. Pure prefill, creating one makes an ordinary automation. The daemon validates each
// against the real trigger schema when building the catalogue and drops what doesn't parse.
export const AutomationTemplateContributionSchema = z.object({
    // Prefills the automation name and is what "does one exist already" is asked by, so spell it as an id, not prose.
    id: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
        .describe('Prefills the automation name, and is what "does one of these exist already" is asked by, so spell it as an id, not as prose.'),
    title: z.string().min(1),
    logo: z.string().min(1).optional().describe("A simple-icons slug for the card."),
    icon: z.string().min(1).optional().describe("A name from the host's icon set, drawn when no simple-icons slug fits."),
    // Capability providers that make this template work; any one connected is enough. Omitted ⇒ nothing to connect,
    // always offered.
    requires: z
        .array(z.string().min(1))
        .optional()
        .describe(
            "Capability providers that make this template work: any one connected is enough (fixing CI rides github or gitlab). Omitted ⇒ nothing to connect, so it is always offered.",
        ),
    // Shaped loosely here and parsed strictly at the merge, since this package can't see the daemon's real trigger
    // union.
    trigger: z
        .object({
            kind: z.enum(["schedule", "event", "listener", "workspace"]),
            cron: z.string().min(1).optional(),
            provider: z.string().min(1).optional(),
            eventType: z.string().min(1).optional(),
            event: z.string().min(1).optional(),
        })
        .describe(
            "What wakes it. Checked against the real trigger schema when the daemon builds the catalogue, so a template can never offer one that would be refused.",
        ),
    guard: z
        .string()
        .min(1)
        .optional()
        .describe("A condition that must hold before the turn runs: what makes a template safe to leave switched on."),
    holdForSeconds: z.number().int().positive().optional().describe("Wait this long and coalesce repeats, rather than firing on every event."),
    prompt: z.string().min(1).describe("The turn this starts. You own the trigger's payload vocabulary, so you own the prompt that reads it."),
    note: z.string().min(1).optional(),
    setup: z.string().min(1).optional().describe("What the user must do themselves before this can work."),
    description: z.string().min(1).optional(),
    // Absent ⇒ waits in the gallery. `create` puts a card that makes it switched off in one click; `configure` opens
    // the dialog prefilled, for a template that can't work unconfigured.
    offer: z
        .enum(["create", "configure"])
        .optional()
        .describe(
            "Absent ⇒ it waits in the gallery, where you go once you know what you want. `create` puts a card on the page that makes it, switched off, in one click. `configure` puts one there that opens the dialog prefilled, for a template that cannot work unconfigured. Both are for what a user would never think to go looking for: mark everything as offered and you have rebuilt the gallery with extra steps.",
        ),
    // Whether what this makes watches this codebase rather than the outside world; declared rather than read off the
    // trigger, since a schedule can point either way.
    chore: z
        .boolean()
        .optional()
        .describe(
            "Whether what this makes watches THIS codebase rather than the outside world. Declared rather than read off the trigger: a nightly dependency sweep and a nightly Stripe poll are both schedules.",
        ),
});
export type AutomationTemplateContribution = z.infer<typeof AutomationTemplateContributionSchema>;

export const automationTemplatesPoint = {
    name: "automationTemplates",
    description:
        "Starting points this pack offers in the automation composer, a trigger, a prompt written for that trigger's payload, and whatever guard makes it safe to leave on. Declared by whoever knows the service rather than by the composer, so they appear when your pack is installed and disappear with it. Pure prefill: creating one makes an ordinary automation.",
    schema: z.array(AutomationTemplateContributionSchema),
} as const satisfies ContributionPoint;
