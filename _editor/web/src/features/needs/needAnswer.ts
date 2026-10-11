import type { Need } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { type OperationReport, useOperations } from "../../workbench/operations/operations";

// A NEED IS ANSWERED ONCE, WHEREVER IT IS DRAWN. Its chat card and the inbox's detail draw the same answer and the daemon
// takes the first, so the answer in flight and how it ended belong to the need, in the operations ledger under its id,
// not to the card that was pressed: a card drawn again mid-answer (the chat scrolled, the inbox reopened) finds its
// buttons still held, and one drawn after a refusal still says why. The yes and "Not now" share the need, so neither
// can be pressed while the other runs.

/** The kind's yes, or the decline beside it. */
export type NeedAct = `answer` | `decline`;

export interface NeedAnswerOptions {
    readonly failed: string;
    readonly task: (report: OperationReport) => Promise<unknown>;
    /** Present tense for the receipt if it ends unwatched; the need's own title by default. */
    readonly what?: string;
    /** Which yes, where a kind offers several. */
    readonly tag?: string;
}

export const useNeedAnswer = (need: MaybeRefOrGetter<Pick<Need, `id` | `title`>>) => {
    const ops = useOperations(() => `needs/${toValue(need).id}`);
    const run = (act: NeedAct, { failed, task, what, tag }: NeedAnswerOptions) =>
        ops.run(act, {
            what:
                what ??
                (act === `decline`
                    ? t(`needs.card.declining`, { title: toValue(need).title })
                    : t(`needs.card.answering`, { title: toValue(need).title })),
            failed,
            tag,
            task: async (report) => {
                await task(report);
            },
        });
    return {
        /** Either act on this need is out. */
        busy: ops.busy,
        /** Why the yes was refused, until it is pressed again. */
        notice: computed(() => ops.at(`answer`)?.failure),
        /** What the yes has printed so far, while it runs. */
        lines: computed(() => {
            const operation = ops.at(`answer`);
            return operation?.state === `running` ? operation.lines : [];
        }),
        declineNotice: computed(() => ops.at(`decline`)?.failure),
        answer: (options: NeedAnswerOptions) => run(`answer`, options),
        decline: (options: NeedAnswerOptions) => run(`decline`, options),
    };
};
