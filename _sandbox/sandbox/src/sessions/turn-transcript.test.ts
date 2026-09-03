import { type AgentEvent, RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { foldTurn, TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { describe, expect, it } from "vitest";
import { withRuntimeHistory } from "../agent/runtime-history.js";
import { openingRows } from "./turn-transcript.js";

// When the turn started: what its user row is stamped with (TranscriptRow.sentAt).
const SENT_AT = 1_767_225_600_000;

/* WHAT A TURN OPENS WITH is the daemon's half of the fold: only the daemon knows what it layered onto the
 * prompt, so only the daemon can take it back off. Everything from the first frame on is the contract's
 * (transcript-fold.test.ts). */
describe("openingRows", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files: read them with the Read tool as needed:\n- /work/shot.png";
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([{ role: "user", text: "fix the build", sentAt: SENT_AT, attachments: ["shot.png"] }]);
    });

    /* WHEN IT WAS SENT, not when its answer finished: the chat draws this on the bubble, and a stamp taken as
     * the turn settles would date a twenty-minute answer's question to twenty minutes after it was asked. Only
     * the user's row carries one: nothing in the frame log says when a given assistant block was written. */
    it("stamps the user's row with the turn's start and leaves the answer unstamped", () => {
        const events: AgentEvent[] = [{ kind: "delta", text: "on it" }];
        expect(foldTurn(openingRows({ prompt: "go" }, "/work", SENT_AT), events).map((message) => message.sentAt)).toEqual([SENT_AT, undefined]);
    });

    /* The handoff envelope is one of those injections. The conversation it carries is THIS record's own earlier
     * rows: the daemon read them out of it to seed the new session, so re-emitting them appended a second,
     * budget-truncated copy of the conversation on every provider or account switch, and a reopened chat showed
     * everything before the switch twice. */
    it("keeps only the typed prompt out of a handoff envelope, never the transcript folded into it", () => {
        const prompt = withRuntimeHistory("second", [
            { role: "user", text: "first" },
            { role: "assistant", text: "sure" },
        ]);
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([{ role: "user", text: "second", sentAt: SENT_AT }]);
    });

    /* A TURN THE DAEMON RE-RAN ITSELF. Its prompt is the user's words again behind a note explaining what killed
     * the first attempt, and recording that verbatim was two wrongs at once: a paragraph of machine prose filed
     * as something the user typed, directly under the copy of the message they really did type. What the record
     * wants there is the one thing neither copy says, which is why the answer below carries on at all. */
    it("opens a re-run with the interruption that caused it, not with the message said twice", () => {
        const prompt = withResumeNote("ship the parser", RESUME_NOTES.auth);
        const events: AgentEvent[] = [{ kind: "delta", text: "picking back up" }];
        expect(foldTurn(openingRows({ prompt }, "/work", SENT_AT), events)).toEqual([
            { role: "notice", text: expect.stringContaining("sign-in renewed") },
            { role: "assistant", text: "picking back up" },
        ]);
    });

    /* The resume that carries NEW words: the daemon came back to a conversation parked on a card and this turn is
     * the answer. Nothing is dropped: it is the only copy of that answer there is, and the restart rides it as
     * the same collapsed note every other thing the daemon told a turn is disclosed as. */
    it("keeps a restored card's answer and carries the restart on it as a note", () => {
        const prompt = withResumeNote("the second option", RESUME_NOTES.answered);
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "the second option", sentAt: SENT_AT, notes: [{ title: expect.any(String), text: RESUME_NOTES.answered }] },
        ]);
    });

    // A re-run's interruption notice replaces the repeated words, and each interruption reads as its own.
    it("names the interruption a re-run stands in for", () => {
        const prompt = withResumeNote("/work is where it lives", RESUME_NOTES.restart);
        const [notice] = openingRows({ prompt }, "/work", SENT_AT);
        expect(notice?.role).toBe("notice");
        expect(notice?.text).toContain("sandbox");
        expect(notice?.text).not.toContain("/work is where it lives");
        const authNotice = openingRows({ prompt: withResumeNote("x", RESUME_NOTES.auth) }, "/work", SENT_AT)[0]?.text;
        expect(notice?.text).not.toBe(authNotice);
    });

    // An inline @-mention rides the same wire field as an upload and is already visible in the words: only the
    // uploads become chips. A path the user also typed keeps its chip when it is an upload, since the chip is
    // the thumbnail.
    it("draws uploads as chips and inline mentions as nothing", () => {
        const upload = ".intentic/records/artifacts/attachments/u1/shot.png";
        const rows = openingRows({ prompt: `see @src/app.ts and @${upload}`, attachments: ["src/app.ts", upload] }, "/work", SENT_AT);
        expect(rows[0]?.attachments).toEqual([upload]);
    });

    it("opens with nothing for a turn with no words and no files", () => {
        expect(openingRows({ prompt: "" }, "/work", SENT_AT)).toEqual([]);
    });

    /* WHICH ROWS A TURN'S STEERS LANDED ON, by position, which is the half of a steered message's bookmark that
     * cannot be known until the fold has run (agent/steer-anchors.ts): the state was pinned when the message
     * arrived, and its index only exists once the fold has decided how many rows the turn wrote before it.
     * Asserted hard because an answer off by one files one message's state under its neighbour's index, and a
     * rewind then restores a point the reader never saw. */
    it("names the rows a turn's steers landed on, whatever the opener did", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "on it" },
            { kind: "steer", text: "and the tests", sentAt: SENT_AT + 1000 },
            { kind: "delta", text: "will do" },
            { kind: "steer", text: "and the docs", sentAt: SENT_AT + 2000 },
        ];
        const fold = new TranscriptFold(openingRows({ prompt: "ship it" }, "/work", SENT_AT));
        for (const event of events) {
            fold.apply(event);
        }
        // prompt, "on it", steer, "will do", steer.
        expect(fold.rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
        expect(fold.steerRows).toEqual([2, 4]);

        // A TURN THAT WROTE NO OPENING ROW: an empty prompt writes none (there is nothing to draw), so the very
        // first user row in the fold is already a steered one.
        const headless = new TranscriptFold(openingRows({ prompt: "" }, "/work", SENT_AT));
        for (const event of events) {
            headless.apply(event);
        }
        expect(headless.rows.map((row) => row.role)).toEqual(["assistant", "user", "assistant", "user"]);
        expect(headless.steerRows).toEqual([1, 3]);
    });
});
