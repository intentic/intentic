import type { Services } from "../../composition.js";
import type { SpokenReplyAsk } from "../../speech/voice/voice.js";
import { withAgentExecution } from "../../workload/agent-execution.js";
import { sentenceAnswer } from "./role-answer.js";
import { askRoleModel, roleModelIsSet } from "./role-model.js";

// The `spoken-reply` job, the speech voice's port filled from up here (composition.ts wires it into speech/voice):
// a written reply made into what a person hears through a speaker when they talk to the agent
// hands-free. Not a summary to read: a few short sentences of speech, saying the outcome and what the person must answer,
// with nothing a voice cannot say (code, paths, markdown). Undefined when no model is set for the job, which is the
// caller's cue to say the reply's own opening instead (voice-text.ts spokenFallback).

// Enough of the reply to say what it did; the end matters as much as the start, since that is where it asks.
const REPLY_CAP = 6_000;
const ASKED_CAP = 1_500;

const clipped = (text: string, cap: number): string =>
    text.length <= cap ? text : `${text.slice(0, Math.floor(cap * 0.6))}\n…\n${text.slice(text.length - Math.floor(cap * 0.4))}`;

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const languageName = (code: string): string => LANGUAGE_NAMES.of(code) ?? code;

export const spokenReplyPrompt = ({ reply, asked, language }: Pick<SpokenReplyAsk, "reply" | "asked" | "language">): string =>
    [
        `A person asked a coding agent something by voice and is now listening, not reading. Its full written reply stays on`,
        `their screen. Write what they hear through the speaker.`,
        ``,
        `- One to three short sentences, sixty words at the most.`,
        `- First the outcome: what was done or found, the part that matters to them.`,
        `- Then, if the reply asks them to decide or answer something, ask it as a plain direct question.`,
        `- Speech only: no markdown, lists, code, file names, paths, URLs or identifiers. Say "the login form", never`,
        `  "LoginForm.vue"; round numbers a listener would round.`,
        `- No greeting, no preamble, no "the agent says": start with the outcome.`,
        `- Write it in ${languageName(language)}.`,
        ``,
        ...(asked === undefined ? [] : [`<asked>`, clipped(asked, ASKED_CAP), `</asked>`, ``]),
        `<reply>`,
        clipped(reply, REPLY_CAP),
        `</reply>`,
        ``,
        `Answer with the spoken words alone.`,
    ].join("\n");

// The words as a voice would take them: a model that wrapped them in quotes or reached for markdown anyway is undone.
const spokenWords = (reply: string): string =>
    reply
        .replaceAll(/[*_`#>]/gu, "")
        .replaceAll(/\s+/gu, " ")
        .trim()
        .replace(/^["“„«']+/u, "")
        .replace(/["”»']+$/u, "")
        .trim();

const SPOKEN_ANSWER = sentenceAnswer("a spoken reply", spokenWords, 90);

// A listener waits on this before the first word; past it, the reply's own opening is said instead.
const DEADLINE_MS = 12_000;

export const composeSpokenReply = async (services: Services, ask: SpokenReplyAsk): Promise<string | undefined> => {
    if (!(await roleModelIsSet(services, "spoken-reply"))) {
        return undefined;
    }
    const { value } = await withAgentExecution(services.agentExecution, { localCwd: services.workspace.root }, (execution) =>
        services.perf.track("voice.spoken-reply", { chars: ask.reply.length }, () =>
            askRoleModel(services, execution, "spoken-reply", { prompt: spokenReplyPrompt(ask), answer: SPOKEN_ANSWER }, AbortSignal.timeout(DEADLINE_MS), {
                // A provider the owner let read this conversation reads its reply here too.
                conversationId: ask.conversationId,
            }),
        ),
    );
    return value;
};
