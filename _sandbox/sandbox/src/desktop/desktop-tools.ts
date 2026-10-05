import { errorMessage } from "@intentic/base/errors";
import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    DesktopError,
    describeInput,
    describeShot,
    ElementRefs,
    FrameLog,
    frameName,
    pointingFor,
    regionFor,
    reshoot,
    type ScreenshotTarget,
    settle,
    shoot,
    type Shot,
    toImage,
    viewFrame,
    perform,
} from "@intentic/desktop-automation";
import { createMcpServer, type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { InProcessServer, RpcMessage, TurnLease } from "../agent/tools/turn-mounts.js";
import { type AgentDesktop, agentDesktop, assertAgentMayDrive, DESKTOP_SIZE, DesktopHeldError, desktopAvailable } from "./agent-desktop.js";

/* The `desktop` tools: the sandbox's own virtual desktop (agent-desktop.ts), driven the way a connected machine is
   (screenshot, then a mouse or keyboard action read in that screenshot's pixels) through the same frame and pointing
   code (@intentic/desktop-automation). Mounted on a turn's lease at the daemon's MCP door like the browser routers, so
   every runtime reaches it. One desktop for the sandbox, so one record of what was shown on it. */

export const DESKTOP_SERVER = "desktop";

const frames = new FrameLog();
// The sandbox's desktop is Linux, which has no element reader; kept so the pointing code reads one shape everywhere.
const refs = new ElementRefs();

// How many identical confirming screenshots in a row come back as a sentence before the pixels are sent again.
const MAX_UNCHANGED = 2;

// What a tool call answers with, as the contract's server builder takes it.
type ToolAnswer = Awaited<ReturnType<McpTool<undefined>["call"]>>;

const where = (desk: AgentDesktop): string =>
    `This is the sandbox's own desktop, X display ${desk.display.name}: start a GUI program on it from your shell with \`DISPLAY=${desk.display.name} <command> &\`, or with \`open\`.`;

const shotContent = (shot: Shot, what: string, desk: AgentDesktop): unknown[] => {
    frames.sent();
    return [
        { type: "text", text: `${describeShot(shot, what)} ${where(desk)}` },
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
    ];
};

// An action's answer: what it did, then the same part of the screen as the latest screenshot, or a sentence when not
// one pixel of it changed.
const confirmingLook = async (said: string, desk: AgentDesktop): Promise<ToolAnswer> => {
    await settle();
    const shot = await reshoot(desk.screen, frames);
    if (shot.unchanged && frames.unchangedStreak() <= MAX_UNCHANGED) {
        return textResult(
            `${said} The screen did not change: screenshot ${shot.frame.id} is still exactly what it shows, so its coordinates still hold. If something should have happened, it did not.`,
        );
    }
    return { content: [{ type: "text", text: said }, ...shotContent(shot, "the same part of the screen as before", desk)], isError: false };
};

const point = z.tuple([z.number(), z.number()]);
const required = z.string().min(1);

const TOOLS: readonly McpTool<undefined>[] = [
    tool({
        name: "screenshot",
        description: `See the sandbox's own desktop (${DESKTOP_SIZE.width}×${DESKTOP_SIZE.height}), a virtual screen for programs that have a window and no other way in: an app you are building, a GUI tool, an installer. It starts the first time you use it. Each screenshot has an id; coordinates you send to input are read in the latest one. Pass \`window\` or \`region\` to look closer at one part. For web pages use the browser tools instead: they act on named elements.`,
        effect: "read",
        input: z
            .object({
                window: required.optional().describe("One window, by its id from list_windows."),
                region: z
                    .tuple([z.number(), z.number(), z.number().positive(), z.number().positive()])
                    .optional()
                    .describe("[x, y, width, height] in pixels of the latest screenshot: zoom in on that part of it."),
            })
            .refine((args) => args.window === undefined || args.region === undefined, { error: "Pass window or region, not both." }),
        run: async ({ window, region }) => {
            const desk = await agentDesktop();
            const target: ScreenshotTarget =
                window !== undefined
                    ? { kind: "window", id: window }
                    : region !== undefined
                      ? { kind: "region", rect: { x: region[0], y: region[1], width: region[2], height: region[3] } }
                      : { kind: "desktop" };
            const { region: area, what } = await regionFor(desk.screen, frames, target);
            return { content: shotContent(await shoot(desk.screen, frames, area), what, desk), isError: false };
        },
    }),
    tool({
        name: "input",
        description:
            "Use the sandbox desktop's mouse and keyboard: click, type into the focused window, press a key combination, scroll, drag. Coordinates are PIXELS IN THE LATEST SCREENSHOT (take one first) and its id goes in `frame`, so a click read off an older one is refused rather than landing where the screen used to be. Every action answers with a fresh screenshot of the same part of the screen, or says the screen did not change. Refused while the owner is driving the desktop from their view.",
        effect: "write",
        input: z.object({
            action: z.enum(["mouse_move", "left_click", "right_click", "middle_click", "double_click", "left_click_drag", "type", "key", "scroll", "wait"]),
            coordinate: point.optional().describe("[x, y] in pixels of the latest screenshot; every pointer action needs it."),
            frame: required.optional().describe("The id of the screenshot the coordinate was read off."),
            to: point.optional().describe("[x, y] the drag ends at (left_click_drag)."),
            text: z.string().optional().describe('The text to type, or the key combination to press: "Return", "ctrl+c", "alt+Tab".'),
            direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction. Default down."),
            amount: z.number().optional().describe("Wheel notches to scroll. Default 3."),
            ms: z.number().optional().describe('How long to wait (action "wait"). Default 400, maximum 10000.'),
        }),
        run: async ({ frame, ...input }) => {
            if (input.action !== "wait") {
                assertAgentMayDrive();
            }
            const desk = await agentDesktop();
            await perform(desk.screen, input, pointingFor(desk.screen, frames, frame, refs));
            return await confirmingLook(describeInput(input), desk);
        },
    }),
    tool({
        name: "list_windows",
        description: "Every window open on the sandbox's desktop: its program, title, place and which one has the keyboard. Places are pixels in the latest screenshot.",
        effect: "read",
        input: z.object({}),
        run: async () => {
            const desk = await agentDesktop();
            const windows = await desk.screen.windows();
            if (windows.length === 0) {
                return textResult(`No windows are open on the sandbox's desktop. ${where(desk)}`);
            }
            const frame = await viewFrame(desk.screen, frames);
            const rows = windows.map((window) => {
                const at = toImage(frame, window.bounds);
                return `${window.focused ? "* " : "  "}[${window.id}] ${window.app}, ${window.title}  (${at.width}×${at.height} at ${at.x},${at.y})`;
            });
            return textResult(
                [`${windows.length} window${windows.length === 1 ? "" : "s"} (* = focused), placed in ${frameName(frame)}. Pass an id to focus_window or screenshot.`, ...rows].join("\n"),
            );
        },
    }),
    tool({
        name: "focus_window",
        description: "Bring a window on the sandbox's desktop to the front and give it the keyboard, by its id from list_windows. Typing goes to the focused window, never to where the pointer is.",
        effect: "write",
        input: z.object({ id: required }),
        run: async ({ id }) => {
            assertAgentMayDrive();
            const desk = await agentDesktop();
            await desk.screen.focusWindow(id);
            // allow(silent-catch): a listing that fails after the focus landed leaves the answer naming the window by its id
            const focused = (await desk.screen.windows().catch(() => [])).find((window) => window.focused);
            return textResult(focused === undefined ? `Asked the desktop to focus window ${id}.` : `Focused: ${focused.app}, ${focused.title}. Typing now goes here.`);
        },
    }),
    tool({
        name: "open",
        description:
            "Start a program on the sandbox's desktop: a command and its arguments, not a shell line (no pipes, no &&). For anything more, run it from your own shell with the DISPLAY a screenshot names. Give it a moment, then list the windows or take a screenshot.",
        effect: "write",
        input: z.object({ command: required.describe(`The program and its arguments, e.g. "xterm" or "${WORKSPACE_ROOT}/app/dist/app --dev".`) }),
        run: async ({ command }) => {
            assertAgentMayDrive();
            const desk = await agentDesktop();
            await desk.screen.launch(command);
            return textResult(`Started ${command} on ${desk.display.name}. Give it a moment, then take a screenshot or list the windows to see it.`);
        },
    }),
    tool({
        name: "clipboard",
        description: "Read or replace the clipboard of the sandbox's desktop: the reliable way to get text in or out of a program there.",
        effect: "write",
        input: z
            .object({ action: z.enum(["read", "write"]), text: z.string().min(1).optional().describe("The text to put on the clipboard (write).") })
            .refine((args) => args.action !== "write" || args.text !== undefined, { error: `"text" is what a write puts on the clipboard.`, path: ["text"] }),
        run: async ({ action, text }) => {
            const desk = await agentDesktop();
            if (action === "write" && text !== undefined) {
                assertAgentMayDrive();
                await desk.screen.writeClipboard(text);
                return textResult(`Put ${text.length} characters on the desktop's clipboard.`);
            }
            const held = await desk.screen.readClipboard();
            return textResult(held === "" ? "The clipboard is empty." : held);
        },
    }),
];

const handleDesktopMessage = createMcpServer<undefined>({
    serverInfo: () => ({ name: DESKTOP_SERVER, version: "1" }),
    tools: TOOLS,
    noSuchTool: (name) => `The sandbox's desktop has no tool called "${name}".`,
    refused: (error) => error instanceof DesktopHeldError,
    // Where a program the desktop is missing comes from in a sandbox: not `apt install` by hand, which the next rebuild
    // forgets, but the browser pack.
    errorMessage: (error) =>
        error instanceof DesktopError && error.install !== undefined
            ? `${error.message} The sandbox's browser pack installs what the desktop needs; it arrives with the sandbox's next rebuild.`
            : errorMessage(error),
    // Nothing to audit to: the turn's own transcript is this desktop's record.
    audit: () => {},
});

// The in-process server a turn's lease mounts; nothing to close, since the desktop outlives every turn.
export const desktopRouter = (): InProcessServer => ({
    handle: async (message: RpcMessage) => {
        const answer = await handleDesktopMessage(message, undefined);
        // SAFETY: createMcpServer answers a JSON-RPC 2.0 object ({ jsonrpc, id, result | error }) or nothing for a
        // notification, which is the shape RpcMessage names.
        return answer as RpcMessage | undefined;
    },
    close: () => {},
});

// A turn's `desktop` mount: offered where the sandbox has a display to give it and the persona may drive a browser,
// the same power, since both put a program on a screen under the agent's hands.
export const desktopServersOf = (lease: Pick<TurnLease, "open">, allowed: boolean): AgentTool[] =>
    allowed && desktopAvailable() ? [lease.open({ name: DESKTOP_SERVER, target: { kind: "browser", router: desktopRouter() } })] : [];
