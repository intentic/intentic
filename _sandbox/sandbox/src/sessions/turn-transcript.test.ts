import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    type AgentEvent,
    childReportPrompt,
    peerMessagePrompt,
    RESUME_NOTES,
    type TranscriptRow,
    watchWakePrompt,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { foldTurn, TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { withRuntimeHistory } from "../agent/providers/runtime-history.js";
import { restoredSessionMessages } from "./sessions.js";
import { openingRows } from "./turn-transcript.js";

// When the turn started: what its user row is stamped with (`TranscriptRow.sentAt`).
const SENT_AT = 1_767_225_600_000;

// Pins the daemon's half of the fold: only it knows what it layered onto the prompt, so only it strips that back off
// before the first frame; everything after is the contract's (transcript-fold.test.ts).
describe("openingRows", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files: read them with the Read tool as needed:\n- /work/shot.png";
        expect(openingRows({ prompt, messageId: "m-1" }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "fix the build", sentAt: SENT_AT, attachments: ["shot.png"], messageId: "m-1" },
        ]);
    });

    // A rewind names the message it goes back to by id, so a message whose sender named none is named here.
    it("names a message its sender left unnamed", () => {
        expect(openingRows({ prompt: "go" }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "go", sentAt: SENT_AT, messageId: expect.any(String) },
        ]);
    });

    // A turn the sandbox opened by itself says so on its row, and what for, so no reader shows it as the owner's words.
    it("carries who spoke the opening and the errand it is", () => {
        expect(openingRows({ prompt: "main is red", messageId: "m-9", speaker: { kind: "sandbox", source: "land-breakage" }, errand: "land-fix" }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "main is red", sentAt: SENT_AT, messageId: "m-9", speaker: { kind: "sandbox", source: "land-breakage" }, errand: "land-fix" },
        ]);
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
        expect(openingRows({ prompt, messageId: "m-2" }, "/work", SENT_AT)).toEqual([
            { role: "user", text: "second", sentAt: SENT_AT, messageId: "m-2" },
        ]);
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
        expect(openingRows({ prompt, messageId: "m-3" }, "/work", SENT_AT)).toEqual([
            {
                role: "user",
                text: "the second option",
                sentAt: SENT_AT,
                messageId: "m-3",
                notes: [{ title: expect.any(String), text: RESUME_NOTES.answered }],
            },
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

    // A condition watch's wake is delivered as an ordinary prompt, so without this it files machine prose under the
    // user's name, in an editable bubble they could rewind the conversation to.
    it("opens a watch's wake as a notice, never as something the user typed", () => {
        const prompt = watchWakePrompt({
            outcome: "met",
            id: "watch-2",
            note: "CI run 316",
            elapsed: "43m",
            command: "gh run view 316",
            exitCode: 0,
            output: "completed",
        });
        expect(openingRows({ prompt }, "/work", SENT_AT)).toEqual([
            {
                role: "notice",
                text: "CI run 316 — the watch fired after 43m.",
                watchWake: { outcome: "met", note: "CI run 316", elapsed: "43m", sent: prompt },
            },
        ]);
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

    // A steer's row index is only known once the fold has run (agent/steer-checkpoints.ts); off by one and a rewind
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

// A prompt the daemon composed reaches the transcript by three separate paths, and each one turns it into rows on its
// own: the daemon's record (openingRows), a live turn taking it as a steer (TranscriptFold), and a provider's own
// session store read back (restoredSessionMessages). A reader that skips the disclosure does not fail loudly — it
// quietly files machine prose under the user's name, and only in the one way it was reached. Comparing the three
// against each other is what notices, including for a path added later.
describe("a prompt nobody typed", () => {
    const WAKE = watchWakePrompt({
        outcome: "met",
        id: "watch-2",
        note: "CI run 316",
        elapsed: "43m",
        command: "gh run view 316",
        exitCode: 0,
        output: "completed",
    });

    // The provider store's own shape for one user message, which is what restoredSessionMessages reduces.
    const stored = (text: string): { type: string; message: unknown } => ({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
    });

    const byEachReader = (prompt: string): TranscriptRow[][] => {
        const fold = new TranscriptFold([]);
        fold.apply({ kind: "steer", text: prompt, sentAt: SENT_AT });
        return [openingRows({ prompt }, WORKSPACE_ROOT, SENT_AT), [...fold.rows], restoredSessionMessages([stored(prompt)], WORKSPACE_ROOT)];
    };

    it("reads the same whichever path it arrives by", () => {
        const [recorded, steered, restored] = byEachReader(WAKE);
        expect(recorded).toEqual([
            { role: "notice", text: "CI run 316 — the watch fired after 43m.", watchWake: expect.objectContaining({ outcome: "met" }) },
        ]);
        expect(steered).toEqual(recorded);
        expect(restored).toEqual(recorded);
    });

    it("is never a user row on any path, whatever else each one does with it", () => {
        for (const rows of byEachReader(WAKE)) {
            expect(rows.map((row) => row.role)).toEqual(["notice"]);
        }
    });

    const PEER = peerMessagePrompt({ from: "sharp-shale-htw8", title: "Bun migration", message: "the sweep is done" });
    const REPORT = childReportPrompt({ child: "sub-x7", title: "Port the parser", failed: true, report: "tests fail", verification: undefined });

    it.each([
        ["a peer's message", PEER, "peer"],
        ["a child's report", REPORT, "child"],
    ] as const)("reads %s as the sender's, the same on every path", (_label, prompt, kind) => {
        const [recorded, steered, restored] = byEachReader(prompt);
        expect(recorded).toEqual([{ role: "notice", text: expect.any(String), agentWords: expect.objectContaining({ kind, sent: prompt }) }]);
        expect(steered).toEqual(recorded);
        expect(restored).toEqual(recorded);
    });

    // The other half: a prompt the user DID type must still reach them as their own words on every path, or this
    // guard could be satisfied by a reader that turns everything into a notice.
    it("leaves a prompt the user typed as the user's own row everywhere", () => {
        for (const rows of byEachReader("fix the build")) {
            expect(rows.map((row) => row.role)).toEqual(["user"]);
            expect(rows[0]?.text).toBe("fix the build");
        }
    });
});
