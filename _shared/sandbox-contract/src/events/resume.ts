import type { TurnNote } from "./transcript.js";

// What a resumed turn's prompt says happened; lives on the wire since the client must recognise it too.

// The shared prefix lets a joining window reuse the existing bubble, not render the note as a new message.
// What follows the note is the original request repeated; `answered` carries the user's actual answer instead.
const REPEATED =
    "The interrupted request is repeated below, where part of it was already completed in this session, continue from that point instead of starting over.";
export const RESUME_NOTES = {
    auth: `The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically. ${REPEATED}`,
    outage: `The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically. ${REPEATED}`,
    restart: `The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back. ${REPEATED}`,
    // Three notes, one allowance failure: `limit` continues, `switched` opens fresh, `refused` says the opposite.
    limit: `The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again. ${REPEATED}`,
    switched:
        "The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again on a different account, which starts a fresh session. The conversation so far has been carried across above, including the part of the request that was already completed, and the sandbox has measured where the work actually stands (the files changed on this branch, what was verified, what the checklist still holds) in the note headed 'Where the work stands': trust that note over anything recalled, then continue from that point instead of starting over.",
    // `carried` switches account but keeps the session, so REPEATED stays true here, unlike `switched`.
    carried: `The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again on a different account of the same provider, in this same session: everything you knew is still here. ${REPEATED}`,
    refused:
        "The model provider refused the previous attempt at this request outright, because its usage allowance was spent: no part of the request below was read or acted on, and nothing has been done towards it. It has been sent again, and starts from the beginning. Where the sandbox has measured earlier work on this branch, it is in the note headed 'Where the work stands'.",
    // A turn parked on the user when the daemon died; what follows the note is their actual answer, not a repeat.
    answered:
        "The sandbox restarted while this conversation was waiting for the user to respond; it is back, and their response follows below: continue from where the session left off.",
} as const;

// The prompt a resume actually sends: the note (each carries its own account of what follows), then the original words.
export const withResumeNote = (prompt: string, note: string): string =>
    Object.values(RESUME_NOTES).some((known) => prompt.startsWith(known)) ? prompt : `${note}\n\n${prompt}`;

// The user's own words inside a resumed prompt, note and explanation stripped. Returns the prompt unchanged when it
// isn't a resume, so any attach head can pass through it.
export const withoutResumeNote = (prompt: string): string => {
    const note = Object.values(RESUME_NOTES).find((known) => prompt.startsWith(known));
    return note === undefined ? prompt : prompt.slice(prompt.indexOf("\n\n") + 2);
};

export type ResumeReason = keyof typeof RESUME_NOTES;

// How a resumed turn's interruption reads to a person: `notice` for the whole-turn re-runs, a muted line with the
// repeat dropped; `note` for the answered case, the user's real answer disclosed normally.
export type ResumeDisclosure = { readonly kind: "notice"; readonly text: string } | { readonly kind: "note"; readonly note: TurnNote };

const RESUME_DISCLOSURES: Record<ResumeReason, ResumeDisclosure> = {
    auth: { kind: "notice", text: "Claude sign-in renewed, this turn picked up where it left off." },
    outage: { kind: "notice", text: "The model provider came back, this turn picked up where it left off." },
    restart: { kind: "notice", text: "The sandbox came back, this turn picked up where it left off." },
    // None of these four auto-resumed, a person pressed Continue; `switched`/`carried` name the differing account.
    limit: { kind: "notice", text: "Sent again after the allowance ran out mid-turn, picking up where it left off." },
    switched: { kind: "notice", text: "Sent again on the switched account after the allowance ran out mid-turn, in a fresh session." },
    carried: { kind: "notice", text: "Sent again on the switched account after the allowance ran out mid-turn, carrying the session with it." },
    refused: { kind: "notice", text: "Sent again after the allowance refused it: nothing had run." },
    answered: { kind: "note", note: { title: "Picked back up after a sandbox restart", text: RESUME_NOTES.answered } },
};

// What a stored prompt's resume note should be shown as; undefined when the prompt isn't a resume, so any reader can
// ask without checking first.
export const resumeDisclosure = (prompt: string): ResumeDisclosure | undefined => {
    const reason = (Object.keys(RESUME_NOTES) as ResumeReason[]).find((key) => prompt.startsWith(RESUME_NOTES[key]));
    return reason === undefined ? undefined : RESUME_DISCLOSURES[reason];
};
