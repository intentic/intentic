import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// One narrowing field the generic automation editor draws for a source — a channel, a branch. `hint` is the
// sentence under the input, for a filter whose empty case is easy to get wrong.
const TriggerFieldContributionSchema = z.object({
    label: z.string().min(1),
    placeholder: z.string().min(1),
    hint: z.string().min(1).optional().describe("The sentence under the input, for a filter whose empty case is easy to get wrong."),
});

/* A realtime listener source the extension supplies. This is the ONE catalog both halves consume: the daemon
 * derives its accepted event types from `events` and folds `automation` into the trigger catalogue it serves,
 * while the automation editor derives the source picker, filters and starter from that. Keeping those facts on
 * the provider extension is what lets a newly installed listener become configurable without a matching app
 * release.
 *
 * The daemon serves a provider-scoped control surface — GET /listeners/<provider>/state to reconcile, POST
 * …/dispatch to wake an automation (optionally holding a turn-stream), …/failure + …/status to report. The
 * daemon holds no provider connection itself.
 *
 * WHAT DISPATCHES IT IS OPEN. A gateway process (contributes.processes) is the usual answer and the one the
 * reconcile feed is shaped for — it holds a live connection the daemon must not. But an extension BACKEND can
 * dispatch through the same route by declaring the dispatch path in `permissions.daemon`, which is
 * how an area that learns things on its own schedule (an estate poller noticing a container died) contributes
 * a trigger without running a gateway at all. Declaring this with neither is legal and inert: the source is
 * offered, and nothing ever fires it. */
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
            // Only sources whose `message` events distinguish addressed messages declare this. Absent means the
            // generic editor offers no mention-only filter rather than inventing provider semantics.
            mentionLabel: z
                .string()
                .min(1)
                .optional()
                .describe(
                    "Only for a source whose message events distinguish being addressed. Absent ⇒ the editor offers no mention-only filter, rather than inventing semantics you did not promise.",
                ),
            channel: TriggerFieldContributionSchema.describe("The primary narrowing filter — a channel, a room, a repo."),
            // A SECOND narrowing axis, for a source whose events carry one — a pipeline's git ref, so a trigger can
            // say "the branch that ships" rather than "every agent's every failure". Absent ⇒ the editor offers
            // only the channel filter.
            branchField: TriggerFieldContributionSchema.optional().describe(
                'A second narrowing axis, for a source whose events carry one — a pipeline\'s git ref, so a trigger can say "the branch that ships" rather than "every agent\'s every failure".',
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
        "A realtime event source this extension supplies, so automations can trigger on it. One declaration feeds both halves: the daemon accepts these event types and serves this provider's control surface, and the automation editor derives its source picker, filters and starter prompt from it — so a newly installed listener is configurable without a matching app release.",
    schema: ListenerContributionSchema,
} as const satisfies ContributionPoint;
