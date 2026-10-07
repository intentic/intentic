import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpAppDataScript } from "@intentic/sandbox-contract";
import { type PageErrorsDeps, reportPageErrors } from "./page-errors.js";
import { publishPage } from "./page-store.js";

// What a page threw in a reader's chat reaches only the turn that drew it, while it runs, once per drawing.

describe("reportPageErrors", () => {
    let root: string;
    let said: { conversationId: string; text: string }[];
    let since: number | undefined;
    let takes: boolean;
    const deps = (): PageErrorsDeps => ({
        workspaceRoot: root,
        runningSince: () => since,
        steer: async (conversationId, text) => {
            if (takes) {
                said.push({ conversationId, text });
            }
            return takes;
        },
    });
    const errors = ["TypeError: width is negative at draw (about:srcdoc:40:9)"];

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "page-errors-"));
        said = [];
        since = Date.now() - 1_000;
        takes = true;
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("tells the running turn that drew the page what it threw, naming the call that redraws it, and only once", async () => {
        const page = await publishPage({ workspaceRoot: root, conversationId: "conv-1", title: "Commits", html: "<svg></svg>" });
        expect(await reportPageErrors(deps(), { page: page.path, errors })).toBe(true);
        expect(said).toHaveLength(1);
        expect(said[0]?.conversationId).toBe("conv-1");
        expect(said[0]?.text).toContain(`The page "${page.id}" you showed threw`);
        expect(said[0]?.text).toContain(`- ${errors[0]}`);
        expect(said[0]?.text).toContain(`replaces: "${page.id}"`);
        // A second window, or the page mounted again, says nothing more.
        expect(await reportPageErrors(deps(), { page: page.path, errors })).toBe(false);
        expect(said).toHaveLength(1);
    });

    it("says nothing with no turn running, for a page an earlier turn drew, or for an MCP server's app", async () => {
        const idle = await publishPage({ workspaceRoot: root, conversationId: "conv-2", title: "A", html: "<p>a</p>" });
        since = undefined;
        expect(await reportPageErrors(deps(), { page: idle.path, errors })).toBe(false);

        const earlier = await publishPage({ workspaceRoot: root, conversationId: "conv-2", title: "B", html: "<p>b</p>" });
        const old = new Date(Date.now() - 60_000);
        utimesSync(join(root, earlier.path), old, old);
        since = Date.now() - 1_000;
        expect(await reportPageErrors(deps(), { page: earlier.path, errors })).toBe(false);

        const app = await publishPage({
            workspaceRoot: root,
            conversationId: "conv-2",
            title: "C",
            html: `<p>app</p>${mcpAppDataScript({ server: "s", tool: "t", input: {}, result: {} })}`,
        });
        expect(await reportPageErrors(deps(), { page: app.path, errors })).toBe(false);
        expect(said).toHaveLength(0);
    });

    it("reads nothing outside the pages folder, and tries again when the turn did not take the words", async () => {
        writeFileSync(join(root, "abcdef0123.r0.html"), "<p>x</p>");
        expect(await reportPageErrors(deps(), { page: "abcdef0123.r0.html", errors })).toBe(false);
        expect(await reportPageErrors(deps(), { page: ".intentic/records/artifacts/pages/../abcdef0123.r0.html", errors })).toBe(false);

        const page = await publishPage({ workspaceRoot: root, conversationId: "conv-3", title: "D", html: "<p>d</p>" });
        takes = false;
        expect(await reportPageErrors(deps(), { page: page.path, errors })).toBe(false);
        takes = true;
        expect(await reportPageErrors(deps(), { page: page.path, errors })).toBe(true);
    });
});
