import { type AgentEvent, RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { foldTurn, TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { describe, expect, it } from "vitest";
import { withRuntimeHistory } from "../agent/providers/runtime-history.js";
import { openingRows } from "./turn-transcript.js";

// When the turn started: what its user row is stamped with (`TranscriptRow.sentAt`).
const SENT_AT = 1_767_225_600_000;

// Pins the daemon's half of the fold: only it knows what it layered onto the prompt, so only it strips that back off
// before the first frame; everything after is the contract's (transcript-fold.test.ts).
describe("openingRows", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files: read them with the Read tool as needed:\n- /work/shot.png";
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([{ role: "user", text: "fix the build", sentAt: SENT_AT, attachments: ["shot.png"] }]);
    });

    // Nothing in the frame log timestamps an individual assistant block, so only the user row can be.
    it("stamps the user's row with the turn's start and leaves the answer unstamped", () => {
        const events: AgentEvent[] = [{ kind: "delta", text: "on it" }];
        expect(foldTurn(openingRows({ prompt: "go" }, "/work", SENT_AT), events).map((message) => message.sentAt)).toEqual([SENT_AT, undefined]);
    });

    // The handoff envelope's embedded history is already this record's own earlier rows; re-emitting it duplicates them
    // on every provider or account switch.
    it("keeps only the typed prompt out of a handoff envelope, never the transcript folded into it", () => {
        const prompt = withRuntimeHistory("second", [
            { role: "user", text: "first" },
            { role: "assistant", text: "sure" },
        ]);
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([{ role: "user", text: "second", sentAt: SENT_AT }]);
    });

    // A re-run's prompt carries a resume note behind the user's original words; recording it verbatim would file
    // machine prose as something typed, on top of the same words already stored.
    it("opens a re-run with the interruption that caused it, not with the message said twice", () => {
        const prompt = withResumeNote("ship the parser", RESUME_NOTES.auth);
        const events: AgentEvent[] = [{ kind: "delta", text: "picking back up" }];
        expect(foldTurn(openingRows({ prompt }, "/work", SENT_AT), events)).toEqual([
            { role: "notice", text: expect.stringContaining("sign-in renewed") },
            { role: "assistant", text: "picking back up" },
        ]);
    });

    // Unlike a re-run's repeated prompt, this resume carries the only copy of the answer; nothing here duplicates.
    it("keeps a restored card's answer and carries the restart on it as a note", () => {
        const prompt = withResumeNote("the second option", RESUME_NOTES.answered);
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "the second option", sentAt: SENT_AT, notes: [{ title: expect.any(String), text: RESUME_NOTES.answered }] },
        ]);
    });

    it("names the interruption a re-run stands in for", () => {
        const prompt = withResumeNote("/work is where it lives", RESUME_NOTES.restart);
        const [notice] = openingRows({ prompt }, "/work", SENT_AT);
        expect(notice?.role).toBe("notice");
        expect(notice?.text).toContain("sandbox");
        expect(notice?.text).not.toContain("/work is where it lives");
        const authNotice = openingRows({ prompt: withResumeNote("x", RESUME_NOTES.auth) }, "/work", SENT_AT)[0]?.text;
        expect(notice?.text).not.toBe(authNotice);
    });

    // An @-mention and an upload share the same wire field; only the uploads become chips, since a plain mention is
    // already visible in the words themselves.
    it("draws uploads as chips and inline mentions as nothing", () => {
        const upload = ".intentic/records/artifacts/attachments/u1/shot.png";
        const rows = openingRows({ prompt: `see @src/app.ts and @${upload}`, attachments: ["src/app.ts", upload] }, "/work", SENT_AT);
        expect(rows[0]?.attachments).toEqual([upload]);
    });

    it("opens with nothing for a turn with no words and no files", () => {
        expect(openingRows({ prompt: "" }, "/work", SENT_AT)).toEqual([]);
    });

    // A steer's row index is only known once the fold has run (agent/steer-anchors.ts); off by one and a rewind
    // restores a point the reader never saw.
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
        expect(fold.rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
        expect(fold.steerRows).toEqual([2, 4]);

        // An empty prompt writes no opening row, so the fold's first user row here is already a steered one.
        const headless = new TranscriptFold(openingRows({ prompt: "" }, "/work", SENT_AT));
        for (const event of events) {
            headless.apply(event);
        }
        expect(headless.rows.map((row) => row.role)).toEqual(["assistant", "user", "assistant", "user"]);
        expect(headless.steerRows).toEqual([1, 3]);
    });
});
