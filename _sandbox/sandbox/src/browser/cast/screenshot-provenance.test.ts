import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Page } from "playwright";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { browserOutputDir } from "./browser-artifacts.js";
import { screenshotFileOf, toolCallIdOf, writeScreenshotProvenance } from "./screenshot-provenance.js";

// The sidecar written beside each screenshot: which file an answer names, and what is said about it.

const answerNaming = (link: string): RpcMessage => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: `### Result\n- [Screenshot of viewport](${link})\n### Ran Playwright code\n` }] },
});

const root = "/work";
const outputDir = browserOutputDir(root);

test("the file an answer names is found inside the output directory, whatever directory the backend linked it from", () => {
    expect(screenshotFileOf(answerNaming(".intentic/records/artifacts/browser/page-1.png"), outputDir)).toBe(join(outputDir, "page-1.png"));
    expect(screenshotFileOf(answerNaming(join(outputDir, "nested/shot.png")), outputDir)).toBe(join(outputDir, "nested/shot.png"));
    // A link outside it, or climbing out of it, names no shot of ours.
    expect(screenshotFileOf(answerNaming("/etc/passwd"), outputDir)).toBeUndefined();
    expect(screenshotFileOf(answerNaming(".intentic/records/artifacts/browser/../../../x.png"), outputDir)).toBeUndefined();
    expect(screenshotFileOf({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: "" }] } }, outputDir)).toBeUndefined();
});

test("the tool call id is read off the request's MCP meta when the client sent one", () => {
    expect(toolCallIdOf({ name: "browser_take_screenshot", _meta: { "claudecode/toolUseId": "toolu_9" } })).toBe("toolu_9");
    expect(toolCallIdOf({ name: "browser_take_screenshot" })).toBeUndefined();
});

test("the sidecar names the conversation, call and page, its address masked like any other browser answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shot-provenance-"));
    try {
        const page = unstubbed<Page>("page", {
            evaluate: (async () => ({
                url: "https://x.com/home?session=abc123",
                readyState: "interactive",
                width: 1280,
                height: 720,
                deviceScaleFactor: 2,
            })) as Page["evaluate"],
        });
        const sidecar = await writeScreenshotProvenance({
            outputDir: dir,
            browser: "identity-1",
            answer: answerNaming(join(dir, "page-2.png")),
            conversationId: "conversation-1",
            toolCallId: "toolu_1",
            page,
            now: () => new Date("2026-10-11T12:00:00Z"),
        });
        expect(sidecar).toBe(join(dir, "page-2.png.json"));
        expect(JSON.parse(await readFile(join(dir, "page-2.png.json"), "utf8"))).toEqual({
            conversationId: "conversation-1",
            toolCallId: "toolu_1",
            browser: "identity-1",
            url: "https://x.com/home?session=***",
            readyState: "interactive",
            viewport: { width: 1280, height: 720, deviceScaleFactor: 2 },
            at: "2026-10-11T12:00:00.000Z",
        });

        // No session tracking the browser: the sidecar still says whose shot it was.
        await writeScreenshotProvenance({ outputDir: dir, browser: "web", answer: answerNaming(join(dir, "page-3.png")), page: undefined });
        expect(JSON.parse(await readFile(join(dir, "page-3.png.json"), "utf8"))).toMatchObject({ browser: "web" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
