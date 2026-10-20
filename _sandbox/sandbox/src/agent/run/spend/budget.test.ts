import { type BudgetAccount, capacity, choose, leastShort, project } from "./budget.js";

/* 2026-10-20, 15:37: radarsu and artur both read five-hour 84% left; radarsu's weekly read 45%, artur's 29%. Two agents
   ran on radarsu and the parent on artur. One point of a five-hour window cost about 1.1M meter units, a weekly one
   about 9.3M, and an Opus child spent about 9M an hour for an hour and a half. */

const M = 1_000_000;
const OPUS = { tokensPerHour: 9 * M, hours: 1.5 };
const RESERVE = 10;

const account = (id: string, fiveHour: number, resetsIn: number, weekly: number, agents: number): BudgetAccount => ({
    id,
    windows: [
        { kind: "five_hour", pool: "five-hour", leftPoints: fiveHour, resetsInHours: resetsIn, tokensPerPoint: 1.1 * M },
        { kind: "seven_day", pool: "weekly", leftPoints: weekly, resetsInHours: 72, tokensPerPoint: 9.3 * M },
    ],
    loadTokensPerHour: agents * OPUS.tokensPerHour,
    agents,
});

const radarsu = account("radarsu", 84, 2.7, 45, 2);
const artur = account("artur", 84, 3.3, 29, 1);

describe("whether an account carries one more agent", () => {
    it("carries nine of the ten children between the two accounts, and the tenth waits", () => {
        expect(capacity([radarsu, artur], OPUS, RESERVE)).toBe(9);
        // Every one of them on radarsu alone, as the room-by-weekly pick sent them: four fit.
        expect(capacity([radarsu], OPUS, RESERVE)).toBe(4);
    });

    it("places the next child where the most room is left after it, which by the five-hour window is artur", () => {
        expect(choose([radarsu, artur], OPUS, RESERVE)?.account.id).toBe("artur");
    });

    it("reads the window that binds and how long it lasts at that load", () => {
        const loaded = { ...radarsu, loadTokensPerHour: 12 * OPUS.tokensPerHour, agents: 12 };
        const projection = project(loaded, OPUS, RESERVE);
        expect(projection.fits).toBe(false);
        expect(projection.binding?.window.kind).toBe("five_hour");
        // 74 usable points at 13 × 9M / 1.1M an hour: about 41 minutes.
        expect(projection.binding?.lastsHours).toBeCloseTo(74 / ((13 * 9) / 1.1), 3);
    });

    it("asks a window that reopens before the child would finish to last only until then", () => {
        const nearReset = account("soon", 20, 0.25, 90, 0);
        expect(project(nearReset, OPUS, RESERVE).fits).toBe(true);
        expect(project({ ...nearReset, windows: [{ ...nearReset.windows[0]!, resetsInHours: 3 }] }, OPUS, RESERVE).fits).toBe(false);
    });

    it("names the account that holds out longest when none carries the child", () => {
        const full = [account("a", 12, 4, 40, 3), account("b", 30, 4, 40, 3)];
        expect(choose(full, OPUS, RESERVE)).toBeUndefined();
        expect(leastShort(full, OPUS, RESERVE)?.account.id).toBe("b");
    });

    it("carries anything on an account no window meters", () => {
        expect(project({ id: "x", windows: [], loadTokensPerHour: 0, agents: 0 }, OPUS, RESERVE)).toMatchObject({ fits: true, margin: 1 });
    });
});
