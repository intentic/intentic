import { fileUrlRefusal, withSandboxNotes } from "./tool-notes.js";

// The notes answer the mistakes agents made in the sandbox's browsers: SwiftShader read as the owner's GPU, Node written
// into browser_run_code_unsafe, a build opened over file://.

describe("the sandbox notes on the browser tools", () => {
    it("say the browser renders in software where a model measures, and what run_code really is", () => {
        const tools = withSandboxNotes([
            { name: "browser_take_screenshot", description: "Take a screenshot of the current page." },
            { name: "browser_run_code_unsafe", description: "Run a Playwright code snippet." },
            { name: "browser_navigate" },
            { name: "browser_click", description: "Perform click on a web page" },
        ]);
        expect(tools[0]?.["description"]).toMatch(/^Take a screenshot of the current page\.\n\n.*SwiftShader.*never the owner's hardware/s);
        expect(tools[1]?.["description"]).toContain("no require, import, process");
        expect(tools[2]?.["description"]).toContain("file:// URLs are refused");
        expect(tools[3]).toEqual({ name: "browser_click", description: "Perform click on a web page" });
    });

    it("refuse a file:// navigation with the way to serve it, and nothing else", () => {
        expect(fileUrlRefusal({ name: "browser_navigate", arguments: { url: "file:///work/game/dist/index.html" } })).toContain(
            "python3 -m http.server",
        );
        expect(fileUrlRefusal({ name: "browser_navigate", arguments: { url: " FILE:///tmp/x.html" } })).toContain("file:// URLs are refused");
        expect(fileUrlRefusal({ name: "browser_navigate", arguments: { url: "http://localhost:8000/" } })).toBeUndefined();
        expect(fileUrlRefusal({ name: "browser_evaluate", arguments: { url: "file:///x" } })).toBeUndefined();
    });
});
