import type { TranscriptNeedWake, TranscriptRow } from "./transcript.js";

// What a need says when its answer reaches a conversation, and how that reads to a person. Delivered as an ordinary
// turn prompt (a steer into a live turn, or a turn of its own), so composing it and recognising it stay one piece of
// knowledge, exactly as a condition watch's wake does (watch-wake.ts): the daemon's record, a steered live turn and a
// provider's session store all turn this prompt back into the same row.

export type NeedWakeOutcome = TranscriptNeedWake["outcome"];

// Per-outcome opening sentence, which is also what the parser anchors on: keep each unique and stable across releases,
// or a reworded opening un-recognises wakes already in a record and they read as the user's own words.
const OPENINGS: Record<NeedWakeOutcome, string> = {
    met: "Need met: a person gave you what you asked for.",
    declined: "Need declined: a person said no to what you asked for. Carry on without it, and say plainly what it would have enabled.",
};

// Labels the prompt writes and the parser reads back. `Need` and `Need id` are load-bearing on both sides.
const NEED = "Need: ";
const NEED_ID = "Need id: ";
const ASKED = "You asked because: ";

export interface NeedWakeFields {
    readonly outcome: NeedWakeOutcome;
    readonly id: string;
    readonly title: string;
    readonly why: string | undefined;
    // The daemon's sentence on how it ended ("Connected as "github".", "Stored under OPENAI_API_KEY.").
    readonly result: string;
    // What the agent can do with it now, and what arrives on its next turn; empty for a decline.
    readonly use: readonly string[];
}

export const needWakePrompt = (fields: NeedWakeFields): string =>
    [
        OPENINGS[fields.outcome],
        `${NEED}${fields.title}`,
        `${NEED_ID}${fields.id}`,
        ...(fields.why === undefined || fields.why === "" ? [] : [`${ASKED}${fields.why}`]),
        fields.result,
        ...fields.use,
        ...(fields.outcome === "met" ? ["Continue the task that needed it."] : []),
    ].join("\n");

const headline = (outcome: NeedWakeOutcome, title: string): string =>
    outcome === "met" ? `${title}: done, and the agent carries on.` : `${title}: declined, and the agent was told.`;

const valueOn = (lines: readonly string[], label: string): string | undefined => lines.find((line) => line.startsWith(label))?.slice(label.length);

// The words a raised need's row carries for a reader that draws no card (search, an export, an older client); the card
// itself is drawn from the need.
export const needRowText = (need: { readonly title: string }): string => `Needs a person: ${need.title}`;

// Which need wake a stored prompt is, if any; undefined for every prompt that isn't one, so any reader can ask without
// checking first. One that opens as a wake but lost its labelled lines is not one.
export const needWakeOf = (prompt: string): TranscriptNeedWake | undefined => {
    const outcome = (Object.keys(OPENINGS) as NeedWakeOutcome[]).find((key) => prompt.startsWith(OPENINGS[key]));
    if (outcome === undefined) {
        return undefined;
    }
    const lines = prompt.split("\n");
    const title = valueOn(lines, NEED);
    const id = valueOn(lines, NEED_ID);
    return title === undefined || id === undefined ? undefined : { outcome, title, id, sent: prompt };
};

// The row a wake becomes: a notice, since a need being answered happened to the conversation rather than being said by
// either side. Undefined when the prompt is not a need wake at all.
export const needWakeRow = (prompt: string): TranscriptRow | undefined => {
    const wake = needWakeOf(prompt);
    return wake === undefined ? undefined : { role: "notice", text: headline(wake.outcome, wake.title), needWake: wake };
};
