import type { TurnReach } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// WHERE A CARD'S LAST TURN PUT ITS WORK WHEN IT WASN'T ITS BRANCH (AgentSummary.reach): files it changed live outside
// it, clones of its own holding work a land never carries, pushes it made itself. Read off what the turn touched, never
// asked of it. Pure like proofSeal.ts beside it, so a board card and a rail row say it the same way.

// Warning when the work is somewhere nobody will review or land it; neutral for a push, which put it somewhere on purpose.
export type ReachTone = `warning` | `neutral`;

export interface ReachLine {
    // The one sentence the card shows: the worst thing first, and how many more its hover holds.
    readonly text: string;
    readonly tone: ReachTone;
    // Every sentence, each followed by the files it stands for, one a line: the hover.
    readonly detail: string;
}

interface Sentence {
    readonly text: string;
    readonly warning: boolean;
    // The files it stands for, listed under it in the hover.
    readonly paths?: readonly string[];
}

const strandedSentence = (clone: NonNullable<TurnReach[`stranded`]>[number]): string => {
    if (clone.uncommitted > 0 && clone.unpushed > 0) {
        return t(`agents.cardReach.strandedBoth`, { uncommitted: clone.uncommitted, unpushed: clone.unpushed, dir: clone.dir });
    }
    return clone.uncommitted > 0
        ? t(`agents.cardReach.uncommitted`, { count: clone.uncommitted, dir: clone.dir }, clone.uncommitted)
        : t(`agents.cardReach.unpushed`, { count: clone.unpushed, dir: clone.dir }, clone.unpushed);
};

const pushedSentence = (push: NonNullable<TurnReach[`published`]>[number]): string => {
    const target =
        push.remote === undefined ? t(`agents.cardReach.upstream`) : push.branch === undefined ? push.remote : `${push.remote}/${push.branch}`;
    return push.dir === undefined ? t(`agents.cardReach.pushedHere`, { target }) : t(`agents.cardReach.pushed`, { target, dir: push.dir });
};

// Worst first: work live outside the branch, then work a land will never carry, then what it sent out on purpose.
const sentencesOf = (reach: TurnReach): Sentence[] => {
    const live = reach.live ?? [];
    const loose = live.filter((entry) => entry.extension === undefined);
    const outside = loose.length + (reach.liveMore ?? 0);
    return [
        ...live.flatMap((entry) =>
            entry.extension === undefined ? [] : [{ text: t(`agents.cardReach.installed`, { extension: entry.extension }), warning: true }],
        ),
        ...(outside > 0
            ? [{ text: t(`agents.cardReach.outside`, { count: outside }, outside), warning: true, paths: loose.map((entry) => entry.path) }]
            : []),
        ...(reach.stranded ?? []).map((clone) => ({ text: strandedSentence(clone), warning: true })),
        ...(reach.strandedMore === undefined
            ? []
            : [{ text: t(`agents.cardReach.strandedMore`, { count: reach.strandedMore }, reach.strandedMore), warning: true }]),
        ...(reach.published ?? []).map((push) => ({ text: pushedSentence(push), warning: false })),
        ...(reach.publishedMore === undefined
            ? []
            : [{ text: t(`agents.cardReach.pushedMore`, { count: reach.publishedMore }, reach.publishedMore), warning: false }]),
    ];
};

export const reachLine = (reach: TurnReach | undefined): ReachLine | undefined => {
    if (reach === undefined) {
        return undefined;
    }
    const sentences = sentencesOf(reach);
    const [first] = sentences;
    if (first === undefined) {
        return undefined;
    }
    const others = sentences.length - 1;
    return {
        text: others === 0 ? first.text : `${first.text} ${t(`agents.cardReach.more`, { count: others })}`,
        tone: first.warning ? `warning` : `neutral`,
        detail: sentences.flatMap((sentence) => [sentence.text, ...(sentence.paths ?? []).map((path) => `  ${path}`)]).join(`\n`),
    };
};
