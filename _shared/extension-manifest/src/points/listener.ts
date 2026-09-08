import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// One narrowing field the generic automation editor draws for a source (a channel, a branch).
const TriggerFieldContributionSchema = z.object({
    label: z.string().min(1),
    placeholder: z.string().min(1),
    hint: z.string().min(1).optional().describe("The sentence under the input, for a filter whose empty case is easy to get wrong."),
});

// A realtime listener source the extension supplies: the daemon derives its accepted event types from `events` and
// folds `automation` into the trigger catalogue; the automation editor derives its source picker, filters and starter
// from the same data. The daemon serves a provider-scoped control surface (GET/POST /listeners/<provider>/...) and
// holds no provider connection itself. What dispatches it is open: a gateway process is the usual answer, but an
// extension backend may dispatch through the same route via `permissions.daemon`. Declaring this with neither is legal
// and inert.
export const ListenerContributionSchema = z.object({
    provider: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .describe("The slug this source's automation triggers fire on."),
    events: z
        .array(
            z.object({
                type: z.string().regex(/^[a-z0-9][a-z0-9_]*$/),
                label: z.string().min(1),
            }),
        )
        .min(1)
        .refine((events) => new Set(events.map((event) => event.type)).size === events.length, {
            message: "listener event types must be unique",
        })
        .describe("The event types this source can fire, with the wording the automation editor offers them under. The daemon accepts no others."),
    automation: z
        .object({
            label: z.string().min(1),
            // Only for a source whose message events distinguish being addressed; absent ⇒ no mention-only filter
            // offered.
            mentionLabel: z
                .string()
                .min(1)
                .optional()
                .describe(
                    "Only for a source whose message events distinguish being addressed. Absent ⇒ the editor offers no mention-only filter, rather than inventing semantics you did not promise.",
                ),
            channel: TriggerFieldContributionSchema.describe("The primary narrowing filter, a channel, a room, a repo."),
            // A second narrowing axis, for a source whose events carry one (e.g. a pipeline's git ref); absent ⇒ only
            // the channel filter is offered.
            branchField: TriggerFieldContributionSchema.optional().describe(
                'A second narrowing axis, for a source whose events carry one: a pipeline\'s git ref, so a trigger can say "the branch that ships" rather than "every agent\'s every failure".',
            ),
            // The provider owns the payload vocabulary, so it also owns the first prompt that explains that payload.
            starterPrompt: z
                .string()
                .min(1)
                .describe(
                    "The first prompt a new automation on this source is prefilled with. You own the payload vocabulary, so you own the prompt that explains it.",
                ),
        })
        .describe("How the generic automation editor presents this source: its name, its filters, and the prompt it starts people on."),
});
export type ListenerContribution = z.infer<typeof ListenerContributionSchema>;

export const listenerPoint = {
    name: "listener",
    description:
        "A realtime event source this extension supplies, so automations can trigger on it. One declaration feeds both halves: the daemon accepts these event types and serves this provider's control surface, and the automation editor derives its source picker, filters and starter prompt from it, so a newly installed listener is configurable without a matching app release.",
    schema: ListenerContributionSchema,
} as const satisfies ContributionPoint;
