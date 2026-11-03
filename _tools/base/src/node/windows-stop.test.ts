import { closeAskedBy, forcedBecause, windowsLauncher } from "./windows-stop.js";

describe("how a Windows program was asked to close", () => {
    test("the launcher's word decides: a break sent, or a window WM_CLOSE reached", () => {
        expect(closeAskedBy(0, 1)).toBe("console");
        expect(closeAskedBy(3, 0)).toBe("window");
        // The launcher found the root windowed even though taskkill failed on a windowless child.
        expect(closeAskedBy(3, 255)).toBe("window");
    });

    // No console (2), a console shared with the agent (4), a failure (1), no answer (null) or no launcher at all: what
    // taskkill managed is what is left.
    test("without a break, taskkill's own exit says whether a window was asked", () => {
        for (const code of [1, 2, 4, null, undefined]) {
            expect(closeAskedBy(code, 0)).toBe("window");
            expect(closeAskedBy(code, 128)).toBe("unasked");
            expect(closeAskedBy(code, null)).toBe("unasked");
        }
    });

    test("a forced stop says whether the program was asked at all", () => {
        expect(forcedBecause("console", 5000)).toBe("it was asked to close (a Ctrl-Break on its console) and had not finished after 5 s");
        expect(forcedBecause("window", 30_000)).toContain("WM_CLOSE");
        expect(forcedBecause("window", 2500)).toContain("after 2.5 s");
        expect(forcedBecause("unasked", 5000)).toMatch(/^it could not be asked: it has no window, and no console/u);
    });

    test("the launcher is only ever looked for on Windows", () => {
        if (process.platform !== "win32") {
            expect(windowsLauncher()).toBeUndefined();
        }
    });
});
