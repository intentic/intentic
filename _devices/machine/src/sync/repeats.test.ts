import { describe, expect, it } from "vitest";
import { quieted } from "./repeats.js";

// The rule the five-second poll loop leans on. Tested with a clock of its own because the thing being measured is a
// cadence, and the failure it exists to stop took two days of real time to show itself.
const collect = (): { readonly lines: string[]; readonly say: (message: string) => void; readonly advance: (ms: number) => void } => {
    const lines: string[] = [];
    let now = 0;
    return {
        lines,
        say: quieted(
            (message) => lines.push(message),
            () => now,
        ),
        advance: (ms: number) => {
            now += ms;
        },
    };
};

const BROKEN = "  sandbox-abc: reconcile skipped: reading the sandbox's ports failed (502)";

describe("quieted", () => {
    it("says a repeating line three times, then once to say it is going quiet, then only every ten minutes", () => {
        const { lines, say, advance } = collect();
        // 200 passes of a five-second loop: a shade under 17 minutes, so exactly one quiet window closes.
        for (let pass = 0; pass < 200; pass += 1) {
            say(BROKEN);
            advance(5000);
        }
        expect(lines).toEqual([
            BROKEN,
            BROKEN,
            BROKEN,
            `${BROKEN} — still, and saying so at most every 10 minutes from here`,
            `${BROKEN} (unchanged, 124 times)`,
        ]);
    });

    it("gives each line its own run, since one pass says several things", () => {
        const { lines, say, advance } = collect();
        for (let pass = 0; pass < 20; pass += 1) {
            say(BROKEN);
            say("  localhost:5440 is busy on this machine");
            advance(5000);
        }
        // Four apiece: three loud and the boundary. Neither line resets the other's run.
        expect(lines.filter((line) => line.startsWith(BROKEN))).toHaveLength(4);
        expect(lines.filter((line) => line.includes("5440"))).toHaveLength(4);
    });

    it("is loud again for a failure that returns after the quiet window, rather than swallowing it", () => {
        const { lines, say, advance } = collect();
        for (let pass = 0; pass < 4; pass += 1) {
            say(BROKEN);
            advance(5000);
        }
        advance(10 * 60_000);
        say(BROKEN);
        expect(lines.at(-1)).toBe(BROKEN);
        expect(lines).toHaveLength(5);
    });

    it("says a line that never repeats exactly as it was given", () => {
        const { lines, say } = collect();
        say("  intentic: fast-forwarded main to e235c5b5");
        say("  intentic: fast-forwarded main to 07ddfe29");
        expect(lines).toEqual(["  intentic: fast-forwarded main to e235c5b5", "  intentic: fast-forwarded main to 07ddfe29"]);
    });
});
