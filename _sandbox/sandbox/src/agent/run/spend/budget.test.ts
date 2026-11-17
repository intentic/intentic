import { type BudgetAccount, capacity, choose, leastShort, project, renewsInHours } from "./budget.js";

/* 2026-10-20, 15:37: radarsu and artur both read five-hour 84% left; radarsu's weekly read 45%, artur's 29%. Two agents
   ran on radarsu and the parent on artur. One point of a five-hour window cost about 1.1M meter units, a weekly one
   about 9.3M, and an Opus child spent about 9M an hour for an hour and a half. */

const M = 1_000_000;
const OPUS = { tokensPerHour: 9 * M, hours: 1.5 };
const RESERVE = 10;

const account = (id: string, fiveHour: number, resetsIn: number, weekly: number, agents: number, weeklyResetsIn = 72): BudgetAccount => ({
    id,
    windows: [
        { kind: "five_hour", pool: "five-hour", leftPoints: fiveHour, resetsInHours: resetsIn, tokensPerPoint: 1.1 * M, periodHours: 5 },
        { kind: "seven_day", pool: "weekly", leftPoints: weekly, resetsInHours: weeklyResetsIn, tokensPerPoint: 9.3 * M, periodHours: 168 },
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

    it("places the next child, between accounts renewing together, where the most room is left after it: artur, by the five-hour window", () => {
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

    /* 2026-11-17: Claude's Ultra plan meters no five-hour window. Two accounts, one with 70 weekly points left renewing
       in six days, one with 40 renewing in ten hours: the most-room pick spent the first and let the second's reset
       unspent. The one renewing first takes children while it carries them, the rest go on the other. */
    it("places a child on the account whose allowance renews first while it carries it, then on the next", () => {
        const weekly = (id: string, left: number, resetsIn: number, agents: number): BudgetAccount => ({
            id,
            windows: [{ kind: "seven_day", pool: "weekly", leftPoints: left, resetsInHours: resetsIn, tokensPerPoint: 9.3 * M, periodHours: 168 }],
            loadTokensPerHour: agents * OPUS.tokensPerHour,
            agents,
        });
        expect(choose([weekly("later", 70, 144, 0), weekly("sooner", 40, 10, 0)], OPUS, RESERVE)?.account.id).toBe("sooner");
        // Thirty usable points carry twenty children's hour and a half; the twenty-first goes on the later account.
        expect(choose([weekly("later", 70, 144, 0), weekly("sooner", 40, 10, 20)], OPUS, RESERVE)?.account.id).toBe("later");
        // Everything both carry is counted alike: the order changes where children go, not how many fit.
        expect(capacity([weekly("later", 70, 144, 0), weekly("sooner", 40, 10, 0)], OPUS, RESERVE)).toBe(capacity([weekly("later", 70, 144, 0), weekly("sooner", 40, 144, 0)], OPUS, RESERVE));
    });

    it("reads renewal off the longest window, so a five-hour reset never decides it, and puts a flapping account last", () => {
        const sooner = account("sooner", 84, 4.5, 40, 0, 20);
        const later = account("later", 84, 0.5, 70, 0, 140);
        expect(renewsInHours(sooner)).toBe(20);
        expect(choose([later, sooner], OPUS, RESERVE)?.account.id).toBe("sooner");
        expect(choose([later, { ...sooner, flapping: true }], OPUS, RESERVE)?.account.id).toBe("later");
        // With no window naming its length, the first to reset decides.
        const unnamed = (id: string, resetsIn: number): BudgetAccount => ({ id, windows: [{ kind: "pool", leftPoints: 50, resetsInHours: resetsIn, tokensPerPoint: 9.3 * M }], loadTokensPerHour: 0, agents: 0 });
        expect(choose([unnamed("b", 30), unnamed("a", 3)], OPUS, RESERVE)?.account.id).toBe("a");
    });

    it("carries anything on an account no window meters", () => {
        expect(project({ id: "x", windows: [], loadTokensPerHour: 0, agents: 0 }, OPUS, RESERVE)).toMatchObject({ fits: true, margin: 1 });
    });
});
