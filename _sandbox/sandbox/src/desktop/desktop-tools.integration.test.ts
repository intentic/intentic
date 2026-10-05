import { existsSync } from "node:fs";
import { requires } from "@intentic/testing/requires";
import { z } from "zod";
import { releaseDisplay } from "../browser/cast/display.js";
import { DESKTOP_KEY, desktopAvailable, ownerDriving, ownerHandedBack } from "./agent-desktop.js";
import { desktopRouter } from "./desktop-tools.js";

/* The sandbox's own desktop through its MCP router, the way the daemon's door calls it: a real Xvfb, a real capture
   and real input. Needs the browser pack's Xvfb, ffmpeg and xdotool. */

const x11 = requires(desktopAvailable(), "the browser pack's Xvfb, ffmpeg and xdotool");

// What a tool call answers, read the way a runtime reads it.
const CallResultSchema = z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional() })),
    isError: z.boolean(),
});

type CallResult = z.infer<typeof CallResultSchema>;

const router = desktopRouter();
let id = 0;
const call = async (name: string, args: Record<string, string | number | readonly number[]> = {}): Promise<CallResult> => {
    id += 1;
    const answer = await router.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return CallResultSchema.parse(answer?.result);
};

const text = (result: CallResult): string => result.content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");

afterAll(() => {
    ownerHandedBack();
    releaseDisplay(DESKTOP_KEY);
});

describe.skipIf(!x11.runs)(x11.title("the sandbox's desktop"), () => {
    test("lists its tools, every one with an object schema", async () => {
        const answer = await router.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
        const { tools } = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({ type: z.string() }) })) }).parse(answer?.result);
        expect(tools.map((entry) => entry.name)).toEqual(["screenshot", "input", "list_windows", "focus_window", "open", "clipboard"]);
        expect(tools.every((entry) => entry.inputSchema.type === "object")).toBe(true);
    });

    test("a screenshot is the whole 1280×800 desktop, unshrunk, with an id and the display to start programs on", async () => {
        const shot = await call("screenshot");
        expect(shot.isError).toBe(false);
        expect(text(shot)).toMatch(/^Screenshot \S+: 1280×800, the whole desktop\. .*X display :\d+/s);
        expect(shot.content.find((part) => part.type === "image")?.data?.length ?? 0).toBeGreaterThan(100);
    });

    test("an action is read in the latest screenshot, and an unchanged screen is said rather than sent again", async () => {
        const shot = await call("screenshot");
        const frame = /^Screenshot (\S+):/.exec(text(shot))?.[1];
        if (frame === undefined) {
            throw new Error(`the screenshot named no frame: ${text(shot)}`);
        }
        const moved = await call("input", { action: "mouse_move", coordinate: [100, 100], frame });
        expect(moved.isError).toBe(false);
        expect(text(moved)).toMatch(/^mouse move at \(100, 100\)\. The screen did not change/);
        const outside = await call("input", { action: "left_click", coordinate: [1280, 10], frame });
        expect(outside.isError).toBe(true);
        expect(text(outside)).toMatch(/outside screenshot/);
    });

    test("while the owner drives, actions are refused and looking is not", async () => {
        ownerDriving(60_000);
        try {
            const refused = await call("input", { action: "left_click", coordinate: [10, 10] });
            expect(refused.isError).toBe(true);
            expect(text(refused)).toMatch(/^Refused: the owner is using this desktop right now/);
            expect((await call("screenshot")).isError).toBe(false);
            expect((await call("input", { action: "wait", ms: 1 })).isError).toBe(false);
        } finally {
            ownerHandedBack();
        }
    });

    test.skipIf(!existsSync("/usr/bin/wmctrl") || !existsSync("/usr/bin/xmessage"))("a program started on it is listed as a window", async () => {
        expect((await call("open", { command: "xmessage -center listed" })).isError).toBe(false);
        let listing = "";
        for (let attempt = 0; attempt < 40 && !listing.includes("xmessage"); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            listing = text(await call("list_windows"));
        }
        expect(listing).toMatch(/\[\S+\] Xmessage, xmessage/);
    });
});
