import { DeadlineArgumentsSchema, ownDeadlineOf } from "@intentic/sandbox-contract/models/device-deadlines";
import { z } from "zod";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import type { CallDeadline } from "./call-failure.js";

// HOW LONG A CALL TO THE OWNER'S DEVICE IS WAITED ON, AT EACH HOP (2026-10-27). 48 device calls (mostly `run_command`,
// some `screenshot`) failed with the bare "The operation timed out." after exactly 60.0 s, and only 3 calls in 739k ever
// came back after 62 s. That sentence is Bun's TimeoutError, raised by the agent's own MCP client: Claude Code gives an
// HTTP MCP server's request 60 s unless the server is configured with a `timeout`, and device mounts had none. So a
// `run_command` whose schema promised 120 s by default and 600 s at most was cut at a minute, while the command ran on
// with nobody to collect it. Three deadlines now nest, innermost first:
// 1. the call's own, on the device (`timeoutMs`, from the contract's table), which stops the command or ends the wait;
// 2. the bridge's here, that one plus the time the device needs to stop it and answer, or a fixed one for a call with
//    none of its own; when it passes, the agent reads which deadline it was and what it left running;
// 3. the agent's MCP client, past the bridge's longest, so it never cuts a call the bridge is still waiting on.

/** The bridge's ceiling on any one device call: past any tool's own deadline, so it only catches a device gone silent. */
export const DEVICE_CALL_CEILING_MS = 15 * 60_000;

/** What the device needs past a call's own deadline: stopping the command and what it started, and answering over the link. */
export const DEVICE_ANSWER_MARGIN_MS = 30_000;

/** What the agent's MCP client is told to wait on one device call (the mount's `timeoutMs`): longer than the bridge ever does. */
export const DEVICE_CLIENT_TIMEOUT_MS = DEVICE_CALL_CEILING_MS + 60_000;

/**
 * The tools that answer in seconds on a device that is well: the screen, input, windows, the clipboard. One that has not
 * answered in this long is wedged on the device (a capture that hung), and the agent is told so instead of waiting out
 * the ceiling; before 2026-10-27 the client's 60 s cut was what caught them, with no word on why.
 */
export const QUICK_CALL_MS = 2 * 60_000;
const QUICK_TOOLS = new Set([
    "describe",
    "screenshot",
    "ui_elements",
    "ui_act",
    "device",
    "list_windows",
    "focus_window",
    "clipboard",
    "list_dir",
    "android_devices",
    "android_screenshot",
    "android_ui_elements",
    "android_act",
]);

// Whole seconds below two minutes, minutes (and seconds) above: how a person reads a wait.
const spokenDuration = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 120) {
        return `${seconds} s`;
    }
    const minutes = Math.floor(seconds / 60);
    return seconds % 60 === 0 ? `${minutes} minutes` : `${minutes} min ${seconds % 60} s`;
};

// A tool call as its deadline is read from it; arguments that do not read as any deadline's are none.
const ToolCallSchema = z.object({ name: z.string(), arguments: DeadlineArgumentsSchema.catch({}).default({}) });

/** How long the bridge waits on this device call, and what the agent reads if it passes; undefined for anything but a tool call. */
export const deviceCallDeadline = (message: RpcMessage): CallDeadline | undefined => {
    const call = message.method === "tools/call" ? ToolCallSchema.safeParse(message.params) : undefined;
    if (call?.success !== true) {
        return undefined;
    }
    const tool = call.data.name;
    const own = ownDeadlineOf(tool, call.data.arguments);
    if (own !== undefined) {
        const ms = own.ms + DEVICE_ANSWER_MARGIN_MS;
        const waited = `within ${spokenDuration(ms)}: its own timeoutMs (${spokenDuration(own.ms)}) plus ${spokenDuration(DEVICE_ANSWER_MARGIN_MS)} for the device to answer`;
        return {
            ms,
            passed: (id) =>
                own.ends === "command"
                    ? `"${id}" did not answer the ${tool} call ${waited}, so the bridge stopped waiting. The device stops a command at its timeoutMs, ` +
                      `together with everything it started, so it has most likely been stopped; but no answer came back to confirm it or to say ` +
                      `what it printed (the device may have lost its link or stalled). Check what it should have changed before running it again.`
                    : `"${id}" did not answer the ${tool} call ${waited}, so the bridge stopped waiting. Only the wait had a deadline: the ` +
                      `program it was watching keeps running on the device either way. Call app_status to see where it stands.`,
        };
    }
    const quick = QUICK_TOOLS.has(tool);
    const ms = quick ? QUICK_CALL_MS : DEVICE_CALL_CEILING_MS;
    const which = quick
        ? `the bridge's deadline for a ${tool} call, which answers in seconds on a device that is well`
        : "the bridge's ceiling on any one device call";
    return {
        ms,
        passed: (id) =>
            `"${id}" did not answer the ${tool} call within ${spokenDuration(ms)}, ${which}, so the bridge stopped waiting. ` +
            `Nothing stops it on the device at this deadline: it may still be running there, or be stuck. Check its result before running it again${quick ? ", and if it keeps happening read device_logs" : ""}.`,
    };
};
