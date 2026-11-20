import { parseStat, ticksBetween } from "./proc.js";

// /proc/<pid>/stat as the kernel writes it, the command name's parentheses included.

describe("parseStat", () => {
    it("reads pid, name, parent, utime + stime and cutime + cstime", () => {
        const line = "4242 (ffmpeg) S 100 4242 100 0 -1 4194304 1234 0 0 0 250 37 20 10 30 10 4 0 999 0 0";
        expect(parseStat(line)).toEqual({ pid: 4242, comm: "ffmpeg", ppid: 100, ticks: 287, reapedTicks: 30 });
    });

    it("counts fields from the last closing parenthesis, so a name holding spaces and parentheses cannot shift them", () => {
        const line = "77 (Web Content (x)) R 1 77 1 0 -1 0 0 0 0 0 11 22 0 0 20 0 1 0 5 0 0";
        expect(parseStat(line)).toEqual({ pid: 77, comm: "Web Content (x)", ppid: 1, ticks: 33, reapedTicks: 0 });
    });

    it("is undefined for a line that is not a stat line", () => {
        expect(parseStat("no parentheses here")).toBeUndefined();
        expect(parseStat("1 (x) S")).toBeUndefined();
    });
});

describe("ticksBetween", () => {
    const snap = (ticks: Record<number, number>, reaped = 0) => ({ ticks: new Map(Object.entries(ticks).map(([pid, value]) => [Number(pid), value])), reaped });

    it("counts a process alive throughout from its first reading", () => {
        expect(ticksBetween(snap({ 10: 500 }), snap({ 10: 752 }), false)).toBe(252);
    });

    it("counts a process started inside the window from zero", () => {
        expect(ticksBetween(snap({ 10: 500 }), snap({ 10: 600, 11: 40 }), false)).toBe(140);
    });

    it("with reaped children, counts one that exited inside the window by its time in the window", () => {
        // 10 had 500 at the start and 530 when it exited and was reaped; 11 started after it and has 40.
        expect(ticksBetween(snap({ 10: 500 }, 1000), snap({ 11: 40 }, 1530), true)).toBe(70);
    });

    it("without them, loses an exited process rather than going negative", () => {
        expect(ticksBetween(snap({ 10: 500 }, 1000), snap({ 11: 40 }, 1530), false)).toBe(40);
    });
});
