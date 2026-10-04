import { moduleSummaryOf } from "./plugin-modules.js";

// The report `claude plugin validate --json` prints, in the shape the pinned CLI printed it for a sample mod (2.1.288).
const report = (notes: string[], errors: { path: string; message: string }[] = []) => ({
    success: errors.length === 0,
    contents: [{ file: "/p/hooks/hooks.json", type: "hooks", errors: errors.map((error) => ({ ...error, code: null })), warnings: [], notes }],
});

describe("moduleSummaryOf", () => {
    test("reads the module's hooks and calls, keeping a matcher's own separators inside it", () => {
        const output = report(["./register.ts hooks: tool.call{tool=Bash|Edit}, session.start", "./register.ts calls: $.fs.write, $.http.fetch, $.process.run"]);

        expect(moduleSummaryOf(output, "./register.ts")).toEqual({
            hooks: ["tool.call{tool=Bash|Edit}", "session.start"],
            calls: ["$.fs.write", "$.http.fetch", "$.process.run"],
        });
    });

    test("a module that calls nothing has no calls, and is not unreadable", () => {
        expect(moduleSummaryOf(report(["./register.ts hooks: prompt.submit"]), "./register.ts")).toEqual({ hooks: ["prompt.submit"], calls: [] });
    });

    test("a module the check refused says why, with nothing claimed about what it does", () => {
        const output = report([], [{ path: "modules../two.ts", message: "demo: /p/hooks/two.ts does not parse: Unexpected end of file (line 1, column 43)" }]);

        expect(moduleSummaryOf(output, "./two.ts")).toEqual({
            hooks: [],
            calls: [],
            unreadable: "demo: /p/hooks/two.ts does not parse: Unexpected end of file (line 1, column 43)",
        });
    });

    test("a report that says nothing of the module is unreadable rather than read as harmless", () => {
        expect(moduleSummaryOf(report(["./other.ts hooks: session.start"]), "./register.ts")).toEqual({
            hooks: [],
            calls: [],
            unreadable: "Claude Code's plugin check did not describe it",
        });
        expect(moduleSummaryOf("not a report", "./register.ts").unreadable).toBe("Claude Code's plugin check did not describe it");
    });
});
