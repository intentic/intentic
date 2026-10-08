import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { decodePng, downscale, encodePng, fitSize, type Frame, FrameLog, type Point, toDesktop, toImage } from "@intentic/desktop-automation";
import { homeDir } from "@intentic/local-agent";
import { COMMAND_CLASS_LABELS, type DeviceScopes } from "@intentic/sandbox-contract";
import { textResult } from "@intentic/sandbox-contract/peer-mcp-server";
import { calling, type Indicator, machineIndicator } from "../indicator.js";
import { assertPath, assertScope, ScopeError } from "../policy.js";
import {
    adbMissing,
    type AndroidDevice,
    AndroidError,
    type AndroidHierarchy,
    androidDestructive,
    assertNoLockoutCommand,
    chooseDevice,
    describeElement,
    findAdb,
    inputTextCommand,
    keyEventFor,
    MAX_SHOWN,
    NO_DEVICE,
    parseAdbDevices,
    parseUiDump,
    parseWmSize,
    type PhoneElement,
    phoneElements,
    rotated,
    type ScreenSize,
    stateNote,
} from "./android-parse.js";
import { assertTypable } from "./device.js";
import { type CollectedOutput, describeResult, destructiveClasses } from "./shell.js";

/* An Android phone attached to this computer over adb, USB or wireless debugging, driven like the desktop: a
   screenshot is a frame with an id (the desktop's FrameLog, one per phone, so a phone frame and a desktop frame never
   stand in for each other), the screen's controls are listed with refs from the accessibility dump, and an action
   answers with a confirming screenshot. The same switches decide: listing and screenshots need `screen`, input needs
   `control`, `android_shell` needs `shell` and, for what the classifiers read as destructive, `destructive`. Every
   tool finds adb and the phone afresh, so a phone plugged in or adb installed after the agent started is found. */

// What an MCP tool answers with, as the peer server builds it.
type ToolResult = ReturnType<typeof textResult>;

// --- running adb -------------------------------------------------------------------------------------------------------

export interface AdbOutput {
    readonly code: number | null;
    readonly stdout: Buffer;
    readonly stderr: string;
    readonly timedOut: boolean;
}

// One adb invocation, argv as adb takes it ("-s", serial, "shell", command). Injected, so every rule here is tested
// without a phone.
export type AdbRunner = (args: readonly string[], timeoutMs: number) => Promise<AdbOutput>;

// The most of one answer held in memory: a screenshot of a big tablet fits many times over, a runaway `cat` does not.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
// adb's first call starts its server, which can inherit the pipes and hold them for its whole life; once the command
// has exited, output that has been quiet this long is all there is.
const PIPE_QUIET_MS = 1_000;
const PIPE_POLL_MS = 50;

// A stream gathered up to `limit` bytes, noting when anything last arrived.
const gather = (limit: number, heard: () => void) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    return {
        take: (chunk: Buffer): void => {
            heard();
            if (bytes < limit) {
                chunks.push(chunk);
                bytes += chunk.length;
            }
        },
        all: (): Buffer => Buffer.concat(chunks),
    };
};

export const adbRunner =
    (binary: string): AdbRunner =>
    async (args, timeoutMs) => {
        const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let lastData = Date.now();
        const heard = (): void => {
            lastData = Date.now();
        };
        const out = gather(MAX_STDOUT_BYTES, heard);
        const err = gather(MAX_STDERR_BYTES, heard);
        child.stdout.on("data", out.take);
        child.stderr.on("data", err.take);
        // Listened for from the start: `close` can follow `exit` within the same tick.
        const closed = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
        let timedOut = false;
        const deadline = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        // Done once the pipes close, or once they have gone quiet with the command already gone.
        const drained = async (): Promise<void> => {
            if (await Promise.race([closed, sleep(PIPE_POLL_MS, { unref: true }).then(() => false)])) {
                return;
            }
            if (Date.now() - lastData >= PIPE_QUIET_MS) {
                child.stdout.destroy();
                child.stderr.destroy();
                return;
            }
            await drained();
        };
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.once("exit", (exitCode) => resolve(exitCode));
                child.once("error", reject);
            });
            await drained();
            return { code, stdout: out.all(), stderr: err.all().toString("utf8"), timedOut };
        } finally {
            clearTimeout(deadline);
        }
    };

// --- what the tools run against ------------------------------------------------------------------------------------------

export interface AndroidDeps {
    // The adb to run, or undefined when this computer has none.
    readonly adb: () => AdbRunner | undefined;
    readonly platform: NodeJS.Platform;
    readonly indicator: () => Indicator;
    // The beat a phone is given to draw an action's result before the confirming screenshot.
    readonly settle: () => Promise<void>;
}

// Android's own transitions run about 300ms; an app opening takes longer than a desktop menu.
const PHONE_SETTLE_MS = 700;

export const machineAndroidDeps = (): AndroidDeps => ({
    adb: () => {
        const binary = findAdb(process.env, process.platform, homeDir(), existsSync);
        return binary === undefined ? undefined : adbRunner(binary);
    },
    platform: process.platform,
    indicator: machineIndicator,
    settle: async () => await sleep(PHONE_SETTLE_MS),
});

// Deadlines per kind of call: listing and reading props are instant, a dump waits for the screen to be idle, an
// install copies a whole APK.
const QUICK_MS = 15_000;
const INPUT_MS = 30_000;
const CAPTURE_MS = 30_000;
const DUMP_MS = 30_000;
const INSTALL_MS = 5 * 60_000;

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 5_000;

// Characters kept of one stream, half from its start and half from its end, as run_command keeps them.
const MAX_OUTPUT = 100_000;

// How many identical confirming screenshots in a row are answered in words, as the desktop's confirming look does.
const MAX_UNCHANGED = 2;

const clip = (text: string): CollectedOutput => {
    if (text.length <= MAX_OUTPUT) {
        return { text, dropped: 0 };
    }
    const half = MAX_OUTPUT / 2;
    const dropped = text.length - MAX_OUTPUT;
    return { text: `${text.slice(0, half)}\n… [${dropped} characters cut] …\n${text.slice(-half)}`, dropped };
};

// What one phone has shown the agent: its screenshots as frames, and the refs of its newest element listing.
interface PhoneView {
    readonly frames: FrameLog;
    elements: ReadonlyMap<string, PhoneElement> | undefined;
}

// The phone a call is about, ready, with the adb that reaches it and what it has shown so far.
interface Phone {
    readonly run: AdbRunner;
    readonly device: AndroidDevice;
    readonly view: PhoneView;
}

interface AndroidContext {
    readonly deps: AndroidDeps;
    // Per serial, for the process's life.
    readonly views: Map<string, PhoneView>;
}

// The id a phone frame is shown under. The prefix is what keeps the two namespaces apart in the agent's reading too:
// a desktop screenshot id handed to android_act is refused by its shape.
export const phoneFrameId = (frame: Frame): string => `phone-${frame.id}`;

const named = (device: AndroidDevice): string => (device.model === undefined ? device.serial : `${device.serial} (${device.model})`);

const outputText = (output: AdbOutput): string => `${output.stdout.toString("utf8")}\n${output.stderr}`.trim();

// The last few lines adb or the phone printed: what a failure is reported with.
const tail = (text: string): string => {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    return lines.slice(-4).join(" / ") || "it printed nothing";
};

const isPng = (bytes: Buffer): boolean => bytes.length > 24 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const adbOf = (context: AndroidContext): AdbRunner => {
    const run = context.deps.adb();
    if (run === undefined) {
        throw new AndroidError(adbMissing(context.deps.platform));
    }
    return run;
};

const listDevices = async (run: AdbRunner): Promise<AndroidDevice[]> => {
    const output = await run(["devices", "-l"], QUICK_MS);
    if (output.code !== 0 || output.timedOut) {
        throw new AndroidError(`adb could not list the attached devices (${tail(outputText(output))}).`);
    }
    return parseAdbDevices(output.stdout.toString("utf8"));
};

const phoneOf = async (context: AndroidContext, serial: string | undefined): Promise<Phone> => {
    const run = adbOf(context);
    const device = chooseDevice(await listDevices(run), serial);
    let view = context.views.get(device.serial);
    if (view === undefined) {
        view = { frames: new FrameLog(), elements: undefined };
        context.views.set(device.serial, view);
    }
    return { run, device, view };
};

// A command for the phone's own shell; one that fails is a failure of the call, with what the phone said.
const shellOn = async ({ run, device }: Phone, command: string, timeoutMs = QUICK_MS): Promise<string> => {
    const output = await run(["-s", device.serial, "shell", command], timeoutMs);
    if (output.timedOut) {
        throw new AndroidError(`${named(device)} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (output.code !== 0) {
        throw new AndroidError(`${named(device)} refused \`${command.split(" ")[0] ?? command}\`: ${tail(outputText(output))}`);
    }
    return output.stdout.toString("utf8");
};

// --- the screen as frames ------------------------------------------------------------------------------------------------

interface PhoneShot {
    readonly frame: Frame;
    readonly png: Buffer;
    readonly unchanged: boolean;
}

const screencap = async ({ run, device }: Phone): Promise<Buffer> => {
    const output = await run(["-s", device.serial, "exec-out", "screencap", "-p"], CAPTURE_MS);
    if (output.timedOut || !isPng(output.stdout)) {
        throw new AndroidError(`${named(device)} did not send a screenshot (${output.timedOut ? "it timed out" : tail(outputText(output))}).`);
    }
    return output.stdout;
};

// The screen as it is now, shrunk as the desktop's are and recorded as the phone's newest frame, unless it is
// pixel-for-pixel the frame before.
const capture = async (phone: Phone): Promise<PhoneShot> => {
    const pixels = decodePng(await screencap(phone));
    const size = fitSize(pixels.width, pixels.height);
    const shown = downscale(pixels, size.width, size.height);
    const digest = createHash("sha256").update(shown.data).digest("hex");
    const { frame, unchanged } = phone.view.frames.record(
        { x: 0, y: 0, width: pixels.width, height: pixels.height },
        shown.width,
        shown.height,
        digest,
    );
    return { frame, png: encodePng(shown), unchanged };
};

const shotContent = (shot: PhoneShot, { device, view }: Phone): unknown[] => {
    view.frames.sent();
    const { frame } = shot;
    const id = phoneFrameId(frame);
    const scale = frame.region.width / frame.width;
    const shrunk = scale > 1.001 ? `, shown at 1/${scale.toFixed(2)} of its ${frame.region.width}×${frame.region.height} pixels` : "";
    return [
        {
            type: "text",
            text:
                `Phone screenshot ${id}: ${frame.width}×${frame.height}, the whole screen of ${named(device)}${shrunk}. ` +
                `Coordinates you give android_act are pixels in this image; pass frame "${id}" with them so a tap is never read off an older one.`,
        },
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
    ];
};

// The frame a coordinate is read in: the phone's newest screenshot, refusing an older one, another phone's, or the
// desktop's.
const frameFor = ({ device, view }: Phone, given: string | undefined): Frame => {
    const latest = view.frames.latest();
    if (latest === undefined) {
        throw new AndroidError(
            `There is no screenshot of ${named(device)} yet: take android_screenshot and read the coordinates off it, or act on a ref from android_ui_elements.`,
        );
    }
    if (given === undefined || given === phoneFrameId(latest)) {
        return latest;
    }
    throw new AndroidError(
        given.startsWith("phone-")
            ? `Phone screenshot ${given} is out of date, or of another phone: the newest of ${named(device)} is ${phoneFrameId(latest)}. Read the coordinates off that one.`
            : `"${given}" is not a phone screenshot: android_act reads coordinates in the newest android_screenshot of the phone (${phoneFrameId(latest)}), never in a screenshot of this computer's desktop.`,
    );
};

// The screen's size in the phone's pixels as it is turned now: the newest screenshot's, else read off a fresh one.
const screenSize = async (phone: Phone): Promise<ScreenSize> => {
    const latest = phone.view.frames.latest();
    if (latest !== undefined) {
        return { width: latest.region.width, height: latest.region.height };
    }
    const png = await screencap(phone);
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

// The look an action answers with: a fresh screenshot, or a sentence when not one pixel changed. The action has
// happened either way, so a screenshot that fails is said, not thrown.
const confirmingLook = async (context: AndroidContext, said: string, phone: Phone, scopes: DeviceScopes): Promise<ToolResult> => {
    if (scopes.screen !== "on") {
        return textResult(`${said} (No screenshot: "See the screen" is off for this device.)`);
    }
    await context.deps.settle();
    try {
        const shot = await capture(phone);
        if (shot.unchanged && phone.view.frames.unchangedStreak() <= MAX_UNCHANGED) {
            return textResult(
                `${said} The phone's screen did not change: phone screenshot ${phoneFrameId(shot.frame)} is still exactly what it shows, so its coordinates still hold. If something should have happened, it did not.`,
            );
        }
        return { content: [{ type: "text", text: said }, ...shotContent(shot, phone)], isError: false };
    } catch (error) {
        return textResult(`${said} (No confirming screenshot: ${errorMessage(error)})`);
    }
};

// --- the screen's elements -----------------------------------------------------------------------------------------------

// The accessibility dump, straight to the terminal where the phone allows it, else through a file it then removes.
const dump = async ({ run, device }: Phone): Promise<AndroidHierarchy> => {
    const direct = await run(["-s", device.serial, "exec-out", "uiautomator", "dump", "/dev/tty"], DUMP_MS);
    const text = direct.stdout.toString("utf8");
    if (text.includes("<hierarchy")) {
        return parseUiDump(text);
    }
    const file = "/sdcard/window_dump.xml";
    const written = await run(["-s", device.serial, "shell", `uiautomator dump ${file}`], DUMP_MS);
    const read = await run(["-s", device.serial, "exec-out", "cat", file], QUICK_MS);
    // allow(silent-catch): a dump file left on the phone is overwritten by the next dump; the answer was already read above.
    await run(["-s", device.serial, "shell", `rm -f ${file}`], QUICK_MS).catch(() => undefined);
    const xml = read.stdout.toString("utf8");
    try {
        return parseUiDump(xml.includes("<hierarchy") ? xml : outputText(written));
    } catch (error) {
        throw new AndroidError(
            `${errorMessage(error)} A screen that never stops moving (a video, a game) cannot be read this way: use android_screenshot and its coordinates.`,
        );
    }
};

// The frame a listing places its elements in: the newest screenshot when it is of the screen as it is turned now,
// else a screenshot-sized frame of the screen, which is what the next screenshot will be.
const listingFrame = async (phone: Phone, hierarchy: AndroidHierarchy): Promise<Frame> => {
    // allow(silent-catch): a `wm size` that fails leaves the size unknown, which falls back to the latest screenshot or the elements' extent below.
    const natural = parseWmSize(await shellOn(phone, "wm size").catch(() => ""));
    const size = natural === undefined ? undefined : rotated(natural, hierarchy.rotation);
    const latest = phone.view.frames.latest();
    if (latest !== undefined && (size === undefined || (latest.region.width === size.width && latest.region.height === size.height))) {
        return latest;
    }
    const screen = size ?? {
        width: Math.max(1, ...hierarchy.nodes.map((node) => node.bounds.x + node.bounds.width)),
        height: Math.max(1, ...hierarchy.nodes.map((node) => node.bounds.y + node.bounds.height)),
    };
    return { id: "", region: { x: 0, y: 0, ...screen }, ...fitSize(screen.width, screen.height), digest: "" };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const listElements = async (
    context: AndroidContext,
    input: { readonly serial?: string | undefined; readonly query?: string | undefined },
    scopes: DeviceScopes,
) => {
    assertScope(scopes, "screen");
    const phone = await phoneOf(context, input.serial);
    const hierarchy = await dump(phone);
    const { elements, total } = phoneElements(hierarchy, input.query);
    phone.view.elements = new Map(elements.map((element) => [element.ref, element]));
    const wanted = input.query?.trim() ?? "";
    const packages = [...new Set(hierarchy.nodes.map((node) => node.packageName).filter((name) => name !== ""))].slice(0, 3);
    const header =
        `${named(phone.device)}: ${wanted === "" ? `${plural(total, "element")} on screen` : `${plural(total, "element")} matching ${JSON.stringify(wanted)}`}` +
        `${packages.length === 0 ? "" : ` (${packages.join(", ")})`}` +
        `${elements.length < total ? `, the first ${MAX_SHOWN} shown (pass query to narrow)` : ""}.`;
    if (elements.length === 0) {
        return `${header} ${wanted === "" ? "Nothing on this screen offers itself to the accessibility dump; use android_screenshot and its coordinates." : "Try a shorter query, or none."}`;
    }
    const frame = await listingFrame(phone, hierarchy);
    const rows = elements.map((element) => {
        const placed = toImage(frame, { ...element.center, width: 1, height: 1 });
        return describeElement(element, { x: placed.x, y: placed.y });
    });
    return [
        header,
        `Positions are pixels in ${frame.id === "" ? `a phone screenshot of this screen (${frame.width}×${frame.height})` : `phone screenshot ${phoneFrameId(frame)}`}. ` +
            `Pass a ref as \`element\` to android_act to tap it where it is; refs hold until the next listing, so list again after the screen changes.`,
        ...rows,
    ].join("\n");
};

// --- acting on the screen ------------------------------------------------------------------------------------------------

export type AndroidAction = "tap" | "long_press" | "swipe" | "type" | "key" | "back" | "home" | "recents" | "scroll";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface AndroidActInput {
    readonly serial?: string | undefined;
    readonly action: AndroidAction;
    readonly element?: string | undefined;
    readonly coordinate?: readonly [number, number] | undefined;
    readonly frame?: string | undefined;
    readonly to?: readonly [number, number] | undefined;
    readonly text?: string | undefined;
    readonly direction?: ScrollDirection | undefined;
    readonly amount?: number | undefined;
    readonly ms?: number | undefined;
}

// What one action sends to the phone's shell, and the words that say it was done.
interface PhoneInput {
    readonly command: string;
    readonly said: string;
}

const NAVIGATION = new Map<AndroidAction, PhoneInput>([
    ["back", { command: "input keyevent KEYCODE_BACK", said: "Pressed Back." }],
    ["home", { command: "input keyevent KEYCODE_HOME", said: "Pressed Home." }],
    ["recents", { command: "input keyevent KEYCODE_APP_SWITCH", said: "Opened the recent apps." }],
]);

// How far one scroll moves and how close to the edges it may start: far enough to move a list by most of a screen,
// slow enough not to fling it further than that.
const SCROLL_FRACTION = 0.45;
const SCROLL_MARGIN = 0.1;
const SCROLL_MS = 400;
const MAX_SCROLLS = 10;
const LONG_PRESS_MS = 800;
const SWIPE_MS = 300;

// The swipe that scrolls `direction` at `at`: the finger moves against it (scrolling down drags the content up), kept
// inside the screen's middle band so it starts on the content and not on a system bar.
export const scrollSwipe = (at: Point, size: ScreenSize, direction: ScrollDirection): readonly [Point, Point] => {
    const vertical = direction === "up" || direction === "down";
    const extent = vertical ? size.height : size.width;
    const length = extent * SCROLL_FRACTION;
    const low = extent * SCROLL_MARGIN + length / 2;
    const high = extent * (1 - SCROLL_MARGIN) - length / 2;
    const centre = Math.min(Math.max(vertical ? at.y : at.x, low), high);
    const forward = direction === "down" || direction === "right";
    const from = Math.round(forward ? centre + length / 2 : centre - length / 2);
    const to = Math.round(forward ? centre - length / 2 : centre + length / 2);
    return vertical
        ? [
              { x: at.x, y: from },
              { x: at.x, y: to },
          ]
        : [
              { x: from, y: at.y },
              { x: to, y: at.y },
          ];
};

const elementFor = ({ device, view }: Phone, ref: string): PhoneElement => {
    const found = view.elements?.get(ref.trim());
    if (found !== undefined) {
        return found;
    }
    if (view.elements === undefined) {
        throw new AndroidError(
            `"${ref}" is not an element of ${named(device)}: list its elements first (android_ui_elements) and pass a ref from that list.`,
        );
    }
    throw new AndroidError(
        view.elements.size === 0
            ? `"${ref}" is not an element of ${named(device)}: its latest list of elements was empty. List them again if the screen changed.`
            : `"${ref}" is not in the latest list of ${named(device)}'s elements (e1 to e${view.elements.size}). List them again if the screen changed.`,
    );
};

// Where a pointer action lands, in the phone's own pixels, and how it is said back; undefined when the call names
// neither an element nor a coordinate.
const pointOf = (phone: Phone, input: AndroidActInput): { readonly at: Point; readonly where: string } | undefined => {
    if (input.element !== undefined && input.element !== "") {
        const element = elementFor(phone, input.element);
        const label = element.label === "" ? "" : ` ${JSON.stringify(element.label.length > 40 ? `${element.label.slice(0, 40)}…` : element.label)}`;
        return { at: element.center, where: `${element.ref}${label}` };
    }
    if (input.coordinate === undefined) {
        return undefined;
    }
    return {
        at: toDesktop(frameFor(phone, input.frame), { x: input.coordinate[0], y: input.coordinate[1] }),
        where: `(${input.coordinate.join(", ")})`,
    };
};

const requiredPoint = (phone: Phone, input: AndroidActInput): { readonly at: Point; readonly where: string } => {
    const point = pointOf(phone, input);
    if (point === undefined) {
        throw new AndroidError(
            `${input.action} needs \`element\` (a ref from android_ui_elements) or \`coordinate\` ([x, y] in the newest phone screenshot).`,
        );
    }
    return point;
};

// A tap, a long press or a swipe: each starts on an element or a coordinate.
const pointerInput = (phone: Phone, input: AndroidActInput): PhoneInput => {
    const { at, where } = requiredPoint(phone, input);
    if (input.action === "tap") {
        return { command: `input tap ${at.x} ${at.y}`, said: `Tapped ${where}.` };
    }
    if (input.action === "long_press") {
        return { command: `input swipe ${at.x} ${at.y} ${at.x} ${at.y} ${Math.round(input.ms ?? LONG_PRESS_MS)}`, said: `Long-pressed ${where}.` };
    }
    if (input.to === undefined) {
        throw new AndroidError(`swipe needs \`to\`: [x, y] in the newest phone screenshot where the finger lifts.`);
    }
    const end = toDesktop(frameFor(phone, input.frame), { x: input.to[0], y: input.to[1] });
    return {
        command: `input swipe ${at.x} ${at.y} ${end.x} ${end.y} ${Math.round(input.ms ?? SWIPE_MS)}`,
        said: `Swiped from ${where} to (${input.to.join(", ")}).`,
    };
};

const scrollInput = async (phone: Phone, input: AndroidActInput): Promise<PhoneInput> => {
    const size = await screenSize(phone);
    const point = pointOf(phone, input);
    const at = point?.at ?? { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) };
    const direction = input.direction ?? "down";
    const times = Math.min(Math.max(1, Math.round(input.amount ?? 1)), MAX_SCROLLS);
    const [from, to] = scrollSwipe(at, size, direction);
    const swipe = `input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${SCROLL_MS}`;
    return {
        command: Array.from({ length: times }, () => swipe).join(" && "),
        said: `Scrolled ${direction}${times > 1 ? ` ${times} times` : ""} at ${point?.where ?? "the middle of the screen"}.`,
    };
};

const requireText = (input: AndroidActInput): string => {
    if (input.text === undefined || input.text === "") {
        throw new AndroidError(
            input.action === "type"
                ? `"text" is required to type.`
                : `"text" is required to press a key: for example "ENTER", "BACK" or "VOLUME_UP".`,
        );
    }
    return input.text;
};

// What the keyboard sends, worked out and judged before the phone is looked for: text that cannot be typed, text that
// would delete, and keys that lock the phone are refused without anything being sent.
const keyboardInput = (input: AndroidActInput, scopes: DeviceScopes): PhoneInput | undefined => {
    if (input.action === "type") {
        const text = requireText(input);
        assertTypable(text, scopes);
        return { command: inputTextCommand(text), said: `Typed ${text.length} characters.` };
    }
    if (input.action === "key") {
        const key = keyEventFor(requireText(input));
        return { command: `input keyevent ${key}`, said: `Pressed ${key}.` };
    }
    return NAVIGATION.get(input.action);
};

const act = async (context: AndroidContext, input: AndroidActInput, scopes: DeviceScopes): Promise<ToolResult> => {
    assertScope(scopes, "control");
    const keyboard = keyboardInput(input, scopes);
    const phone = await phoneOf(context, input.serial);
    const sent = keyboard ?? (input.action === "scroll" ? await scrollInput(phone, input) : pointerInput(phone, input));
    await context.deps.indicator().control(calling.getStore());
    await shellOn(phone, sent.command, INPUT_MS);
    return await confirmingLook(context, sent.said, phone, scopes);
};

// --- the shell, installs and the log ---------------------------------------------------------------------------------------

const runShell = async (
    context: AndroidContext,
    input: { readonly serial?: string | undefined; readonly command: string; readonly timeoutMs?: number | undefined },
    scopes: DeviceScopes,
): Promise<string> => {
    assertScope(scopes, "shell");
    // Read before the phone is looked for, so a destructive command is refused for what it does. The shared classifier
    // and the phone's own list can both name a recursive delete; it is said once.
    const labels = [
        ...new Set([
            ...destructiveClasses(input.command).map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
            ...androidDestructive(input.command),
        ]),
    ];
    if (labels.length > 0 && scopes.destructive !== "on") {
        throw new ScopeError(
            `Refused: on the phone this command would ${labels.join(" and ")}, and "Run destructive commands" is switched off for this device. ` +
                `Turn it on in its capability card to allow this, or run a command that does not.`,
        );
    }
    assertNoLockoutCommand(input.command);
    const { run, device } = await phoneOf(context, input.serial);
    const timeout = Math.min(input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS);
    const output = await run(["-s", device.serial, "shell", input.command], timeout);
    const result = {
        exitCode: output.timedOut ? null : output.code,
        stdout: clip(output.stdout.toString("utf8")),
        stderr: clip(output.stderr),
        timedOut: output.timedOut,
        lingering: false,
    };
    return `On ${named(device)}: ${describeResult(result, timeout)}`;
};

const install = async (
    context: AndroidContext,
    input: { readonly serial?: string | undefined; readonly path: string },
    scopes: DeviceScopes,
): Promise<string> => {
    assertScope(scopes, "shell");
    assertScope(scopes, "write");
    const real = await assertPath(input.path, scopes, "install");
    if (!/\.apk$/i.test(real)) {
        throw new AndroidError(
            `"${input.path}" is not an .apk: adb install takes an APK file (an .aab has to be turned into one first, with bundletool).`,
        );
    }
    if ((await stat(real).catch(undefinedIfMissing))?.isFile() !== true) {
        throw new AndroidError(`There is no file "${input.path}" on this computer.`);
    }
    const { run, device } = await phoneOf(context, input.serial);
    const output = await run(["-s", device.serial, "install", "-r", real], INSTALL_MS);
    if (output.timedOut) {
        throw new AndroidError(`Installing ${input.path} on ${named(device)} did not finish within ${INSTALL_MS / 60_000} minutes.`);
    }
    const said = outputText(output);
    if (output.code !== 0 || !/\bSuccess\b/.test(said)) {
        throw new AndroidError(`${named(device)} did not install ${input.path}: ${tail(said)}`);
    }
    return `Installed ${input.path} on ${named(device)}, replacing the app's earlier version if it had one (its data is kept).`;
};

export type LogPriority = "V" | "D" | "I" | "W" | "E" | "F";

const PRIORITY_WORDS = { V: "verbose", D: "debug", I: "info", W: "warning", E: "error", F: "fatal" } satisfies Record<LogPriority, string>;

export interface LogcatInput {
    readonly serial?: string | undefined;
    readonly lines?: number | undefined;
    readonly package?: string | undefined;
    readonly tag?: string | undefined;
    readonly priority?: LogPriority | undefined;
}

// A package and a tag reach logcat's argv and the phone's shell, so each is held to what the name can be.
const assertLogFilters = ({ package: app, tag }: LogcatInput): void => {
    if (app !== undefined && !/^[A-Za-z]\w*(?:\.[A-Za-z_]\w*)*$/.test(app)) {
        throw new AndroidError(`"${app}" is not an Android package name, like com.example.app.`);
    }
    if (tag !== undefined && !/^[\w.$/-]+$/.test(tag)) {
        throw new AndroidError(`"${tag}" is not a log tag logcat can filter by: letters, digits and . _ $ / - only.`);
    }
};

// The process an app runs as, which is how logcat narrows to it.
const pidOf = async (phone: Phone, app: string): Promise<string> => {
    // allow(silent-catch): pidof exits non-zero when nothing runs under that name, which is the "not running" answered just below.
    const pid = (await shellOn(phone, `pidof ${app}`).catch(() => ""))
        .trim()
        .split(/\s+/)
        .find((word) => /^\d+$/.test(word));
    if (pid === undefined) {
        throw new AndroidError(
            `${app} is not running on ${named(phone.device)}, so it has no log of its own to show: start it, or leave out package to read the whole log.`,
        );
    }
    return pid;
};

// logcat's filter spec: one tag at a priority with everything else silenced, or a priority for every tag.
const logFilters = ({ tag, priority }: LogcatInput): string[] => {
    if (tag !== undefined) {
        return [`${tag}:${priority ?? "V"}`, "*:S"];
    }
    return priority === undefined ? [] : [`*:${priority}`];
};

const logScope = (input: LogcatInput, pid: string | undefined): string =>
    [
        input.package === undefined ? "" : ` from ${input.package} (pid ${pid ?? "?"})`,
        input.tag === undefined ? "" : ` tagged ${input.tag}`,
        input.priority === undefined ? "" : ` at ${PRIORITY_WORDS[input.priority]} or above`,
    ].join("");

const logcat = async (context: AndroidContext, input: LogcatInput, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "shell");
    assertLogFilters(input);
    const phone = await phoneOf(context, input.serial);
    const { run, device } = phone;
    const count = Math.min(input.lines ?? DEFAULT_LOG_LINES, MAX_LOG_LINES);
    const pid = input.package === undefined ? undefined : await pidOf(phone, input.package);
    const output = await run(
        ["-s", device.serial, "logcat", "-d", "-t", String(count), ...(pid === undefined ? [] : [`--pid=${pid}`]), ...logFilters(input)],
        INPUT_MS,
    );
    if (output.timedOut || output.code !== 0) {
        throw new AndroidError(`logcat on ${named(device)} failed: ${output.timedOut ? "it timed out" : tail(outputText(output))}`);
    }
    const log = clip(output.stdout.toString("utf8").replace(/\r\n/g, "\n").trimEnd());
    const scope = logScope(input, pid);
    if (log.text.trim() === "") {
        return `Nothing in ${named(device)}'s log${scope} among its last ${count} lines.`;
    }
    return `Up to the last ${count} lines of ${named(device)}'s log${scope}${log.dropped === 0 ? "" : `, ${log.dropped} characters cut from the middle`}:\n${log.text}`;
};

// --- the device list -------------------------------------------------------------------------------------------------------

// One attached device as the listing shows it: what adb said, and for a ready one what the phone says about itself.
interface ListedDevice extends AndroidDevice {
    readonly ready: boolean;
    readonly note: string | undefined;
    readonly androidVersion: string | undefined;
    readonly sdk: number | undefined;
    readonly screen: string | undefined;
}

const describeDevice = async (run: AdbRunner, device: AndroidDevice): Promise<ListedDevice> => {
    const note = stateNote(device.state);
    if (note !== undefined) {
        return { ...device, ready: false, note, androidVersion: undefined, sdk: undefined, screen: undefined };
    }
    const props = await run(["-s", device.serial, "shell", "getprop ro.build.version.release; getprop ro.build.version.sdk; wm size"], QUICK_MS)
        .then((output) => (output.code === 0 ? output.stdout.toString("utf8") : ""))
        // allow(silent-catch): a listing still names a device whose properties cannot be read; its version and screen read as unknown.
        .catch(() => "");
    const [release = "", sdk = ""] = props.split(/\r?\n/).map((line) => line.trim());
    const screen = parseWmSize(props);
    return {
        ...device,
        ready: true,
        note: undefined,
        androidVersion: release === "" ? undefined : release,
        sdk: /^\d+$/.test(sdk) ? Number(sdk) : undefined,
        screen: screen === undefined ? undefined : `${screen.width}×${screen.height}`,
    };
};

const listAttached = async (context: AndroidContext, scopes: DeviceScopes): Promise<string> => {
    assertScope(scopes, "shell");
    const run = adbOf(context);
    const devices = await listDevices(run);
    if (devices.length === 0) {
        return NO_DEVICE;
    }
    const described = await Promise.all(devices.map(async (device) => await describeDevice(run, device)));
    const ready = described.filter((device) => device.ready).length;
    const head =
        devices.length === 1
            ? `1 Android device is attached to this computer${ready === 1 ? "; the other android_* tools act on it when no serial is given" : ""}.`
            : `${devices.length} Android devices are attached to this computer: pass \`serial\` to the other android_* tools to say which one.`;
    return `${head}\n${JSON.stringify(described, undefined, 2)}`;
};

// --- the tools ---------------------------------------------------------------------------------------------------------------

export interface Android {
    readonly devices: (scopes: DeviceScopes) => Promise<string>;
    readonly screenshot: (serial: string | undefined, scopes: DeviceScopes) => Promise<ToolResult>;
    readonly uiElements: (
        input: { readonly serial?: string | undefined; readonly query?: string | undefined },
        scopes: DeviceScopes,
    ) => Promise<string>;
    readonly act: (input: AndroidActInput, scopes: DeviceScopes) => Promise<ToolResult>;
    readonly shell: (
        input: { readonly serial?: string | undefined; readonly command: string; readonly timeoutMs?: number | undefined },
        scopes: DeviceScopes,
    ) => Promise<string>;
    readonly install: (input: { readonly serial?: string | undefined; readonly path: string }, scopes: DeviceScopes) => Promise<string>;
    readonly logcat: (input: LogcatInput, scopes: DeviceScopes) => Promise<string>;
}

// The Android tools over one set of dependencies; each phone's frames and refs live as long as the returned object.
export const createAndroid = (deps: AndroidDeps): Android => {
    const context: AndroidContext = { deps, views: new Map() };
    return {
        devices: async (scopes) => await listAttached(context, scopes),
        screenshot: async (serial, scopes) => {
            assertScope(scopes, "screen");
            const phone = await phoneOf(context, serial);
            return { content: shotContent(await capture(phone), phone), isError: false };
        },
        uiElements: async (input, scopes) => await listElements(context, input, scopes),
        act: async (input, scopes) => await act(context, input, scopes),
        shell: async (input, scopes) => await runShell(context, input, scopes),
        install: async (input, scopes) => await install(context, input, scopes),
        logcat: async (input, scopes) => await logcat(context, input, scopes),
    };
};
