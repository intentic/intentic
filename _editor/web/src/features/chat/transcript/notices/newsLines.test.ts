import { movedHereWords, childNewsOf, stoppedWords, restartedWords } from "@intentic/sandbox-contract/events/child-news";
import { firstSentence, newsBlock } from "./newsLines";

const FAILURE =
    "Preparing the runner's workspace failed: the runner \"omen\" runs an older build (0.0.0), whose sync can lose a turn's uncommitted work, so nothing was sent there. Update it (Devices, its Update button), or move this conversation here to go on in this sandbox.";
const moved = (child: string, title: string) => childNewsOf(movedHereWords({ child, title }, `omen`, FAILURE))!;

describe(`newsBlock`, () => {
    // 2026-11-26: four subagents one cause moved here read as four screens of the owner's own words.
    it(`says what became of them once, and the cause they share once, with the way to where it is fixed`, () => {
        const block = newsBlock([moved(`sub-a`, `#8 Lighter pnpm dev`), moved(`sub-b`, `#2 Targeted reclaim`), moved(`sub-c`, `#1 WSL card`)]);
        expect(block.heading).toContain(`3`);
        expect(block.heading).toContain(`omen`);
        expect(block.shared).toBe(true);
        expect(block.cause).toBe(
            `Preparing the runner's workspace failed: the runner "omen" runs an older build (0.0.0), whose sync can lose a turn's uncommitted work, so nothing was sent there.`,
        );
        expect(block.tone).toBe(`warning`);
        expect(block.devices).toBe(true);
    });

    it(`leaves each line its own words, and says no cause, where they differ`, () => {
        const block = newsBlock([moved(`sub-a`, `A`), childNewsOf(stoppedWords({ child: `sub-b`, title: `B` }, `no fallback took it.`))!]);
        expect(block.shared).toBe(false);
        expect(block.cause).toBeUndefined();
        // The loudest line colours the rail.
        expect(block.tone).toBe(`danger`);
    });

    it(`draws one piece of news as its line alone, with its own cause under it`, () => {
        const one = newsBlock([childNewsOf(stoppedWords({ child: `sub-b`, title: `B` }, `its allowance never reopened. Send it again.`))!]);
        expect(one.heading).toBeUndefined();
        expect(one.cause).toBe(`its allowance never reopened.`);
        expect(newsBlock([childNewsOf(restartedWords({ child: `sub-c` }))!])).toMatchObject({ cause: undefined, tone: `neutral`, devices: false });
    });
});

describe(`firstSentence`, () => {
    it(`never cuts a version or a file name in half`, () => {
        expect(firstSentence(`Runs 0.0.0 from app.ts now. Then more.`)).toBe(`Runs 0.0.0 from app.ts now.`);
        expect(firstSentence(`no stop at all`)).toBe(`no stop at all`);
    });
});
