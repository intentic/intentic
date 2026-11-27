import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { firstTurnCounts, firstTurnDocument, firstTurnRecorder, readFirstTurnNow } from "./first-turn.js";

// The first turn a person started that finished without failing, recorded once on the history volume for the platform's
// funnel (first-turn.ts). Real files in a temp history root.

type Settled = DomainEventMap["run.settled"];

const PERSON = { kind: "person", email: "ada@example.com" } as const;

// A run that settled well, spoken by a person, in their own words; each case changes one thing.
const settled = (change: Partial<Settled> = {}): Settled => ({
    conversationId: "c1",
    run: "r1",
    actor: PERSON.email,
    speaker: PERSON,
    failure: undefined,
    closing: "Done.",
    ...change,
});

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "first-turn-"));
const logger = () => ({ info: jest.fn(), warn: jest.fn() });

describe("which settled runs count as a person's first turn", () => {
    // A re-run the sandbox sent after a failure settles with the person who asked as its speaker, so it reads the same.
    it("counts a person's own words that finished", () => {
        expect(firstTurnCounts(settled())).toBe(true);
    });

    it("counts no program, automation, carry-on, child or peer", () => {
        expect(firstTurnCounts(settled({ speaker: { kind: "program", token: "ci" }, actor: "token:ci" }))).toBe(false);
        expect(firstTurnCounts(settled({ speaker: { kind: "sandbox", source: "automation:a1" }, actor: undefined }))).toBe(false);
        expect(firstTurnCounts(settled({ speaker: { kind: "sandbox", source: "turn-cap" }, actor: undefined }))).toBe(false);
        expect(firstTurnCounts(settled({ speaker: { kind: "agent", conversationId: "parent" }, actor: "agent:parent" }))).toBe(false);
        // A run the daemon started itself names nobody.
        expect(firstTurnCounts(settled({ speaker: undefined, actor: undefined }))).toBe(false);
    });

    it("counts no words the app composed under the person's name, nor a run that failed or was stopped", () => {
        expect(firstTurnCounts(settled({ errand: "land-conflict" }))).toBe(false);
        expect(firstTurnCounts(settled({ failure: "the provider refused" }))).toBe(false);
        expect(firstTurnCounts(settled({ failure: "spent", rerun: { at: 1_764_150_000 } }))).toBe(false);
        expect(firstTurnCounts(settled({ stopped: true }))).toBe(false);
    });
});

describe("the first-turn recorder", () => {
    it("records the first run that counts once, tells the announcer once, and never moves it", async () => {
        const root = historyRoot();
        const recorded = jest.fn();
        let now = 1_764_150_000_000;
        const note = firstTurnRecorder({ historyRoot: root, logger: logger(), recorded, now: () => now });

        await note(settled({ speaker: { kind: "sandbox" }, actor: undefined }));
        await note(settled({ failure: "boom" }));
        expect(readFirstTurnNow(root)).toBeUndefined();
        expect(recorded).not.toHaveBeenCalled();

        await note(settled());
        now += 60_000;
        await note(settled({ conversationId: "c2" }));
        expect(JSON.parse(readFileSync(join(root, firstTurnDocument.path), "utf8"))).toEqual({ at: 1_764_150_000_000 });
        expect(readFirstTurnNow(root)).toBe(1_764_150_000_000);
        expect(recorded).toHaveBeenCalledTimes(1);
    });

    it("keeps what an earlier life recorded: a recorder after a restart neither writes nor tells", async () => {
        const root = historyRoot();
        writeFileSync(join(root, firstTurnDocument.path), JSON.stringify({ at: 1_700_000_000_000 }));
        const recorded = jest.fn();
        const note = firstTurnRecorder({ historyRoot: root, logger: logger(), recorded, now: () => 1_764_150_000_000 });
        await note(settled());
        expect(readFirstTurnNow(root)).toBe(1_700_000_000_000);
        expect(recorded).not.toHaveBeenCalled();
    });

    it("records nothing for a daemon with no history volume", async () => {
        const recorded = jest.fn();
        await firstTurnRecorder({ historyRoot: "", logger: logger(), recorded })(settled());
        expect(readFirstTurnNow("")).toBeUndefined();
        expect(recorded).not.toHaveBeenCalled();
    });

    it("says so when the moment cannot be written, and tries again at the next run that counts", async () => {
        // A history root that is a file: nothing can be written under it.
        const root = join(historyRoot(), "not-a-directory");
        writeFileSync(root, "");
        const log = logger();
        const recorded = jest.fn();
        const note = firstTurnRecorder({ historyRoot: root, logger: log, recorded });
        await note(settled());
        await note(settled({ conversationId: "c2" }));
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(recorded).not.toHaveBeenCalled();
    });
});
