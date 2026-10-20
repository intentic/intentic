import { withStderrTail } from "./vendor-errors.js";

/* A process's stderr folded into the sentence it explains. How a failure's words are read is error-frames.test.ts. */

test("stderr joins the sentence it explains, trimmed, and an empty tail adds nothing", () => {
    expect(withStderrTail("Pi exited mid-turn (code 1)", "  boom: missing key\n")).toBe("Pi exited mid-turn (code 1): boom: missing key");
    expect(withStderrTail("Pi exited mid-turn (code 1)", " \n ")).toBe("Pi exited mid-turn (code 1)");
});
