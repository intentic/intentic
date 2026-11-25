import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import { z } from "zod";
import type { Json, VendorQuestion } from "./dialect.js";
import { vendorMethod } from "./dialect.js";

// Grok Build's ask-user tool (`ask_user_question`), which asks through a request of its own, `_x.ai/ask_user_question`,
// rather than ACP's form elicitation. Read off recorded 1.0.46 traffic (transcribed from Orca's s5-plan-approved
// fixture) and Grok's own answer shapes: `{ outcome: "accepted", answers: { <question>: <label> | <label>[] } }`, with a
// question left out of `answers` when it was skipped, own words carried as the answer "Other" with the words under
// `annotations[<question>].notes`, and `{ outcome: "cancelled" }` when nobody answers.

const QUESTION_METHOD = "x.ai/ask_user_question";
const HEADER = "Grok asks";
// The label Grok's own card answers with for words of the person's own.
const OTHER = "Other";

const RequestSchema = z.object({
    sessionId: z.string(),
    questions: z
        .array(
            z.looseObject({
                question: z.string().min(1),
                multiSelect: z.boolean().nullish().catch(undefined),
                options: z.array(z.looseObject({ label: z.string(), description: z.string().nullish().catch(undefined) })).catch([]),
            }),
        )
        .min(1),
});

const CANCELLED: Json = { outcome: "cancelled" };

export const grokQuestion = (method: string, params: Json): VendorQuestion | undefined => {
    if (vendorMethod(method) !== QUESTION_METHOD) {
        return undefined;
    }
    const parsed = RequestSchema.safeParse(params);
    if (!parsed.success) {
        return undefined;
    }
    const questions: AskQuestion[] = parsed.data.questions.map((asked) => ({
        question: asked.question,
        header: HEADER,
        multiSelect: asked.multiSelect === true,
        options: asked.options.map((option) => ({ label: option.label, description: option.description ?? "" })),
    }));
    return {
        sessionId: parsed.data.sessionId,
        questions,
        cancelled: CANCELLED,
        answer: (reply) => {
            if (reply.cancelled === true) {
                return CANCELLED;
            }
            const answers: Record<string, Json> = {};
            const annotations: Record<string, Json> = {};
            for (const question of questions) {
                const picks = (reply.answers?.[question.question] ?? []).map((pick) => pick.trim()).filter((pick) => pick !== "");
                const labels = picks.filter((pick) => question.options.some((option) => option.label === pick));
                const own = picks.filter((pick) => !labels.includes(pick));
                if (own.length > 0) {
                    labels.push(OTHER);
                    annotations[question.question] = { notes: own.join("\n") };
                }
                if (labels.length > 0) {
                    answers[question.question] = question.multiSelect ? labels : (labels[0] ?? OTHER);
                }
            }
            return Object.keys(annotations).length > 0 ? { outcome: "accepted", answers, annotations } : { outcome: "accepted", answers };
        },
    };
};
