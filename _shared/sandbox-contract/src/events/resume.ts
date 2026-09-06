import type { TurnNote } from "./transcript.js";

/* WHAT A RESUMED TURN'S PROMPT SAYS IT IS. The daemon re-runs a turn something underneath it killed by sending
 * the original prompt again behind one of these sentences, so the model knows what interrupted it — and they
 * live on the wire rather than in the daemon because the CLIENT has to recognise them too, or a window joining
 * a resumed run renders the note as a message the user wrote. */

/* WHAT A RESUMED TURN'S PROMPT SAYS IT IS. The daemon re-runs a turn something underneath it killed (turn-resume.ts)
 * by sending the original prompt again behind one of these sentences, so the model knows what interrupted it.
 *
 * They live on the wire rather than in the daemon because the CLIENT has to recognise them too: an attach head
 * carries the run's prompt verbatim, and a window joining a resumed run would otherwise render the note as a
 * message the USER wrote, the same words the user already said one run up, with a machine's preamble on them.
 * Recognising the prefix is what lets that window reuse the bubble that is already there instead. */
// The instruction the three whole-turn re-runs share: what follows the note is the original request, repeated.
// `answered` deliberately does not carry it, what follows THAT note is not a repetition but the user's answer,
// and telling the model to "continue from that point instead of starting over" about words it has never seen
// is how a resume reads as the user contradicting themselves.
const REPEATED =
    "The interrupted request is repeated below, where part of it was already completed in this session, continue from that point instead of starting over.";
export const RESUME_NOTES = {
    auth: `The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically. ${REPEATED}`,
    outage: `The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically. ${REPEATED}`,
    restart: `The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back. ${REPEATED}`,
    /* A SPENT ALLOWANCE STRANDS A TURN IN THREE SHAPES, and they must not share a note.
     *
     * `limit` is the mid-turn one and reads like its three neighbours above: the session holds real work, and
     * carrying on from it is exactly right.
     *
     * `switched` is that same mid-turn stranding picked back up on a DIFFERENT account (or provider, or
     * harness), which is what the composer's account switcher does between the refusal and the press. A session
     * belongs to the credential that minted it, so this one cannot resume: it opens a fresh session seeded from
     * the daemon's record. REPEATED's "already completed in this session" is therefore false where it counts —
     * the work is in the carried-across conversation, not in this session's own history — and a model told to
     * look for it there finds nothing and starts over silently.
     *
     * `refused` is the turn the provider turned away at the door, before the model read one word of it, and it
     * is the COMMONER of the two, because an allowance that is already spent refuses the first request it is
     * asked. REPEATED is actively wrong for it: "part of it was already completed in this session, continue from
     * that point instead of starting over" is an instruction to continue from work that does not exist, and a
     * model handed that instruction answers it by inventing the work. So it says the opposite, plainly.
     *
     * Both are unlike their neighbours in one way worth stating: nothing resumed automatically. A spent
     * allowance is the user's own budget and stays their call to spend (turn-resume.ts), so what re-ran this
     * turn was a person pressing Continue. */
    limit: `The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again. ${REPEATED}`,
    switched:
        "The model provider's usage allowance ran out while this turn was running, which stopped it, and it has been sent again on a different account, which starts a fresh session. The conversation so far has been carried across above, including the part of the request that was already completed: continue from that point instead of starting over.",
    refused:
        "The model provider refused the previous attempt at this request outright, because its usage allowance was spent: no part of the request below was read or acted on, and nothing has been done towards it. It has been sent again, and starts from the beginning.",
    // A turn that was PARKED on the user when the daemon died: nothing re-runs at boot, the card is restored
    // instead, and this is the turn their answer starts (turn-resume.ts). What rides below the note is the
    // answer itself, so the model picks the session back up at exactly the decision it had handed over.
    answered:
        "The sandbox restarted while this conversation was waiting for the user to respond; it is back, and their response follows below: continue from where the session left off.",
} as const;

// The prompt a resume actually sends: the note (each carries its own account of what the words below are),
// then them.
export const withResumeNote = (prompt: string, note: string): string =>
    Object.values(RESUME_NOTES).some((known) => prompt.startsWith(known)) ? prompt : `${note}\n\n${prompt}`;

// The user's own words inside a resumed prompt, the note and its explanation stripped back off. Returns the
// prompt unchanged when it is not a resume, so a caller can hand every attach head through it.
export const withoutResumeNote = (prompt: string): string => {
    const note = Object.values(RESUME_NOTES).find((known) => prompt.startsWith(known));
    return note === undefined ? prompt : prompt.slice(prompt.indexOf("\n\n") + 2);
};

export type ResumeReason = keyof typeof RESUME_NOTES;

/* HOW A RESUMED TURN READS TO THE PERSON, the same interruption the note above tells the model, said in the
 * transcript's own voice instead.
 *
 * Stripping the note out of the user's words is only half the job, and for years it was the only half anyone
 * did: what a reopened conversation showed was a paragraph of machine prose stapled to the front of a message
 * the user had already sent once, directly under their own copy of it. Both halves of that are wrong, it was
 * never their sentence, and the words under it are a REPEAT rather than something new they said.
 *
 * So the two shapes below, which is the whole of what a reader has to be told:
 *
 * `notice`, the three whole-turn re-runs. The words under the note are already in the transcript one turn up,
 * so the repeat is dropped entirely and the interruption takes its place as a muted line, sitting with the
 * failure line it resolves ("Failed to authenticate…") and reading like every other thing that HAPPENED to a
 * turn rather than like something anybody typed.
 *
 * `note`, the answered case, where what rides under the note is the user's actual answer to a card and belongs
 * in the transcript as their words. Nothing is dropped; the explanation rides that message as a collapsed row,
 * the same disclosure every other daemon-written note gets (TurnNote). */
export type ResumeDisclosure = { readonly kind: "notice"; readonly text: string } | { readonly kind: "note"; readonly note: TurnNote };

const RESUME_DISCLOSURES: Record<ResumeReason, ResumeDisclosure> = {
    auth: { kind: "notice", text: "Claude sign-in renewed, this turn picked up where it left off." },
    outage: { kind: "notice", text: "The model provider came back, this turn picked up where it left off." },
    restart: { kind: "notice", text: "The sandbox came back, this turn picked up where it left off." },
    /* THE THREE NOBODY AUTOMATED, said in the passive voice the other three earn honestly and these do not: a
     * person pressed Continue. Which is the whole reason these rows exist at all. A press used to append the word
     * "Continue" as a message of its own, so a chat that bounced off a spent allowance four times read back as
     * the user saying "Continue" four times to an agent that had answered none of them, and the provider session
     * the model actually reads accumulated all four (plus a synthetic "No response requested." per press). One
     * row for one press was never the problem; a row that claims the user said something new is.
     *
     * `switched` names the account because that is the fact the reader needs: they pressed the same button they
     * pressed a minute ago, and the difference between the press that bounced and the press that worked is who
     * served it. The line is also the only place a retired session is accounted for. */
    limit: { kind: "notice", text: "Sent again after the allowance ran out mid-turn, picking up where it left off." },
    switched: { kind: "notice", text: "Sent again on the switched account after the allowance ran out mid-turn, in a fresh session." },
    refused: { kind: "notice", text: "Sent again after the allowance refused it: nothing had run." },
    answered: { kind: "note", note: { title: "Picked back up after a sandbox restart", text: RESUME_NOTES.answered } },
};

// What a stored prompt's resume note should be SHOWN as; undefined when the prompt is not a resume at all, so
// every reader of a stored prompt can ask without first testing whether it is one.
export const resumeDisclosure = (prompt: string): ResumeDisclosure | undefined => {
    const reason = (Object.keys(RESUME_NOTES) as ResumeReason[]).find((key) => prompt.startsWith(RESUME_NOTES[key]));
    return reason === undefined ? undefined : RESUME_DISCLOSURES[reason];
};
