import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import type { IconName, Tone } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { Audience } from "../../../../app/useAudience";
import { noticeFailure, noticeLine, type NoticePlace } from "../../../../models/conversations/transcript/sandboxNotice";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { agentNoticeLookOf, isTurnChecks, noticeIconOf } from "./noticeLook";

/* A NOTICE AS AN EVENT, not a sentence: who or what it is about first, then how it ended in its own colour, then where
   or after how long. The sandbox's sentence buried the subject mid-line ('Subagent "Optimizations slice E: …" finished on
   omen-runner.'); a row reads these parts at a glance, each with its own weight. A notice with no parts of its own is
   its whole sentence as the subject, so every code still draws. */

export interface NoticeParts {
    readonly subject: string;
    // How it ended, a word or two drawn in the tone: "finished", "fired".
    readonly outcome: string | undefined;
    // Where, or after how long: the machine a subagent ran on, how long a watch waited.
    readonly context: string | undefined;
    readonly tone: Tone;
    readonly icon: IconName;
}

const parts = (subject: string, tone: Tone, icon: IconName, outcome?: string, context?: string): NoticeParts => ({ subject, outcome, context, tone, icon });

// In-progress failures are the sandbox still at it, not a wall.
const WORKING: ReadonlySet<string> = new Set([`retrying`, `renewing`]);
// Where the work went, and how that reads.
const LAND_TONES: ReadonlyMap<string, Tone> = new Map<string, Tone>([
    [`landed`, `success`],
    [`intoParent`, `success`],
    [`landHeld`, `info`],
    [`landConflict`, `danger`],
    [`intoParentClash`, `warning`],
]);

/** Another agent's report or message, or a watch that fired: its sender as the subject. */
const arrivalParts = (row: ChatMessage): NoticeParts | undefined => {
    const words = row.agentWords;
    if (words !== undefined) {
        const who = words.title ?? words.from;
        if (words.kind === `peer`) {
            return parts(who, `info`, `comments`, t(`chat.noticeParts.sentMessage`));
        }
        return words.failed === true
            ? parts(who, `danger`, `times`, t(`chat.noticeParts.failed`), words.machine)
            : parts(who, `success`, `check`, t(`chat.noticeParts.finished`), words.machine);
    }
    const watch = row.watchWake;
    if (watch !== undefined) {
        const after = t(`chat.noticeParts.after`, { elapsed: watch.elapsed });
        if (watch.outcome === `met`) {
            return parts(watch.note, `info`, `eye`, t(`chat.noticeParts.fired`), after);
        }
        return parts(watch.note, `warning`, `eye`, watch.outcome === `timeout` ? t(`chat.noticeParts.gaveUp`) : t(`chat.noticeParts.stopped`), after);
    }
    return undefined;
};

// A runtime's own notice (an extension, the loop, the end-of-turn checks): its level's tone, and who said it.
const runtimeParts = (row: ChatMessage, line: string): NoticeParts | undefined => {
    const look = agentNoticeLookOf(row);
    if (look === undefined) {
        return undefined;
    }
    const level = row.agentNotice?.level;
    const loud: Tone | undefined = level === `error` ? `danger` : level === `warning` ? `warning` : undefined;
    // The end-of-turn checks are always worth their own glyph; another runtime's info line is as quiet as any notice.
    return isTurnChecks(row) ? parts(line, loud ?? `info`, `list-check`) : parts(line, loud ?? `neutral`, look.icon, undefined, row.agentNotice?.source);
};

// An answered need, as its card says it ended.
const needParts = (row: ChatMessage): NoticeParts | undefined => {
    const need = row.needWake;
    if (need === undefined) {
        return undefined;
    }
    return need.outcome === `met`
        ? parts(need.title, `success`, noticeIconOf(row, false), t(`chat.noticeParts.given`))
        : parts(need.title, `danger`, noticeIconOf(row, false), t(`chat.noticeParts.declined`));
};

/** The parts a notice row reads in, in the reader's language and words. */
export const noticePartsOf = (row: ChatMessage, audience: Audience, place: NoticePlace = {}): NoticeParts => {
    const line = noticeLine(row, audience, place) ?? row.text;
    const spoken = arrivalParts(row) ?? runtimeParts(row, line) ?? needParts(row);
    if (spoken !== undefined) {
        return spoken;
    }
    const code = sandboxNoticeOf(row)?.code;
    if (noticeFailure(row) !== undefined) {
        return parts(line, WORKING.has(code ?? ``) ? `info` : `warning`, `exclamation-triangle`);
    }
    return parts(line, LAND_TONES.get(code ?? ``) ?? `neutral`, noticeIconOf(row, false));
};
