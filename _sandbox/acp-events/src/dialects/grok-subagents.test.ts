import { reportOf } from "./grok-subagents.js";

describe("reportOf", () => {
    it("keeps the words a person reads and cuts Grok's machine blocks", () => {
        expect(reportOf("<subagent_meta>{\"id\":1}</subagent_meta>Done: 3 files.<subagent_result>raw</subagent_result>")).toBe("Done: 3 files.");
    });

    it("cuts a block to the first closer of its own kind, as before", () => {
        expect(reportOf("a<subagent_meta>x</subagent_result>y</subagent_meta>b</subagent_meta>c")).toBe("ab</subagent_meta>c");
        expect(reportOf("a<subagent_meta>x<subagent_result>y</subagent_result>z</subagent_meta>b")).toBe("ab");
    });

    it("leaves an opener with no closer standing, and still cuts the other kind after it", () => {
        expect(reportOf("a<subagent_meta>b<subagent_result>c</subagent_result>d")).toBe("a<subagent_meta>bd");
    });

    it("has nothing to report for nothing or only machine blocks", () => {
        expect(reportOf(undefined)).toBeUndefined();
        expect(reportOf(null)).toBeUndefined();
        expect(reportOf("<subagent_result>x</subagent_result>  ")).toBeUndefined();
    });

    it("answers on many openers with no closer, which the old pattern scanned in quadratic time", () => {
        const flood = "<subagent_meta>".repeat(200_000);
        // No clock: the old pattern was quadratic on this, so a return of it runs past the test's own timeout.
        expect(reportOf(flood)?.length).toBe(4_000);
    });
});
