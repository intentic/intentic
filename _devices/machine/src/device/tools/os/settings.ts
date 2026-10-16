import { existsSync } from "node:fs";
import { plural, sizeLabel } from "@intentic/base/format";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    IC_OS_DRIVE_NO_ROOM_EXIT,
    IC_OS_NO_SCREEN_EXIT,
    IC_OS_WIFI_PASSWORD_EXIT,
    icOsDisplayListArgs,
    icOsDisplaySetArgs,
    icOsDriveEjectArgs,
    icOsDriveImportArgs,
    icOsDrivesListArgs,
    icOsKeyboardLayoutsArgs,
    icOsKeyboardSetArgs,
    icOsKeyboardStatusArgs,
    icOsNetworkStatusArgs,
    icOsSoundOutputArgs,
    icOsSoundOutputsArgs,
    icOsSoundSetArgs,
    icOsSoundStatusArgs,
    icOsWifiConnectArgs,
    icOsWifiForgetArgs,
    icOsWifiListArgs,
    icOsWifiRadioArgs,
    INTENTIC_OS_RELEASE_PATH,
    IntenticOsBlockDeviceSchema,
    type IntenticOsDisplayList,
    IntenticOsDisplayListSchema,
    type IntenticOsDisplayMode,
    IntenticOsDisplayModeSchema,
    IntenticOsDisplayNameSchema,
    IntenticOsDriveImportSchema,
    type IntenticOsDrives,
    IntenticOsDrivesSchema,
    IntenticOsImportPathSchema,
    type IntenticOsKeyboardLayout,
    type IntenticOsKeyboardLayouts,
    IntenticOsKeyboardLayoutsSchema,
    type IntenticOsKeyboardStatus,
    IntenticOsKeyboardStatusSchema,
    type IntenticOsNetworkStatus,
    IntenticOsNetworkStatusSchema,
    IntenticOsSandboxSlugSchema,
    IntenticOsScaleSchema,
    type IntenticOsSoundOutputs,
    IntenticOsSoundOutputsSchema,
    type IntenticOsSoundStatus,
    IntenticOsSoundStatusSchema,
    IntenticOsSsidSchema,
    type IntenticOsWifiList,
    IntenticOsWifiListSchema,
    IntenticOsXkbNameSchema,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { type McpTool, textResult, tool } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { assertScope } from "../../policy.js";
import { holdIcFlow, type IcRun } from "../sandboxes.js";
import { answerOf, assertSeeing, notIntenticOs, OS_DEPS, type OsDeps, said } from "./os.js";

// THE MACHINE'S OWN SETTINGS, on Intentic OS (2026-10-16): its network, its sound, its screens, its keyboard and the
// drives a person plugs into it. Every setting a person can change at the machine (This computer, on its own screen) is a
// tool here too, so the agent in the machine's own sandbox can do what they would: "connect to the guest Wi-Fi", "turn it
// down", "copy the USB stick into my sandbox". Thin callers of `ic os …`, like the OS tools beside them (os.ts): argv
// spelled by the contract, ic's JSON read as the contract's, ic's exit codes said in words, and nothing of NetworkManager,
// WirePlumber, sway or udisks spoken here. A read takes either seeing switch; a change takes "Manage sandboxes on this
// device", the switch that already says a sandbox may look after this box.

// A read of what the machine has now: seconds on a machine that is well.
const READ_DEADLINE_MS = 30_000;
// The Wi-Fi list rescans first, which takes a few seconds, longer with many networks in reach.
const SCAN_DEADLINE_MS = 60_000;
// Joining a network: NetworkManager gives one 90 seconds to answer, then the machine asks it for an address.
const JOIN_DEADLINE_MS = 2 * 60_000;
// A change that applies at once: a volume, a screen's mode, a layout, a network forgotten, the radio.
const CHANGE_DEADLINE_MS = 60_000;
// Ejecting first writes out whatever the drive still has pending, which on a slow stick takes minutes.
const EJECT_DEADLINE_MS = 5 * 60_000;
// An import has none: a big drive takes many minutes, and like an OS update it is left to finish.

// A verb's own exit code, said in words from what ic printed.
interface Refusal {
    readonly code: number;
    readonly says: (output: string) => string;
}

interface IcAsk {
    readonly args: string[];
    readonly deadlineMs: number | undefined;
    // Written to ic's stdin: a Wi-Fi password, the one secret any of these verbs takes.
    readonly input?: string | undefined;
    // What did not happen, for a failure ic has no exit code of its own for.
    readonly failed: string;
    readonly refusal?: Refusal;
}

// One `ic os` verb, already allowed. What went to ic's stdin is cut out of what comes back, so even an ic that echoed
// it could not put it into an answer, the chat or the audit log's failure line.
const icOs = async (deps: OsDeps, ask: IcAsk): Promise<IcRun> => {
    const ran = await deps.ic(ask.args, { deadlineMs: ask.deadlineMs, input: ask.input });
    const run = ask.input === undefined || ask.input === "" ? ran : { ...ran, output: ran.output.replaceAll(ask.input, "<the password>") };
    notIntenticOs(run);
    if (ask.refusal !== undefined && run.code === ask.refusal.code) {
        throw new Error(ask.refusal.says(run.output));
    }
    if (run.code !== 0) {
        throw new Error(`${ask.failed}\n\n${run.output}`);
    }
    return run;
};

// A read: either seeing switch, behind a deadline, ic's one line of JSON read as the contract's.
const readOs = async <T>(
    scopes: DeviceScopes,
    deps: OsDeps,
    ask: Omit<IcAsk, "deadlineMs"> & { readonly deadlineMs?: number },
    schema: z.ZodType<T>,
): Promise<T> => {
    assertSeeing(scopes);
    const run = await icOs(deps, { deadlineMs: READ_DEADLINE_MS, ...ask });
    return answerOf(run.output, schema, ask.args.join(" "));
};

// What the reads answer with: ic's JSON as the contract reads it, passed on as JSON, as os_status is, since a model reads
// keys as well as prose.
type Answer =
    | IntenticOsNetworkStatus
    | IntenticOsWifiList
    | IntenticOsSoundStatus
    | IntenticOsSoundOutputs
    | IntenticOsDisplayList
    | IntenticOsKeyboardStatus
    | IntenticOsKeyboardLayouts
    | IntenticOsDrives;
const json = (answer: Answer): string => JSON.stringify(answer, undefined, 2);

const NO_SCREEN: Refusal = {
    code: IC_OS_NO_SCREEN_EXIT,
    says: (output) =>
        `This device's edition of Intentic OS has no screen (it is the server edition), so it has no displays or keyboard layout to read or change.\n\n${output}`,
};

// Where a Wi-Fi password comes from when this machine does not know it: never the chat, where it would stay in the
// transcript for good.
const PASSWORD_FROM =
    "Do not ask the owner to paste it into chat, where it would stay in the transcript: ask them to join the network from This computer on this machine's own screen, or to give you the password some way that leaves no copy in the conversation, and pass it as `password`.";

const wifiPassword = (ssid: string, given: boolean): Refusal => ({
    code: IC_OS_WIFI_PASSWORD_EXIT,
    says: (output) =>
        given
            ? `"${ssid}" did not accept that password, so this machine did not join it. ${PASSWORD_FROM}\n\n${output}`
            : `"${ssid}" needs a password this machine does not know, so it did not join it. ${PASSWORD_FROM}\n\n${output}`,
});

// ic's own sentence for a refusal: its last line that is not one of its JSON lines.
const sentenceOf = (output: string): string =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .findLast((line) => line !== "" && !line.startsWith("{")) ?? "";

const noRoom = (device: string, sandbox: string): Refusal => ({
    code: IC_OS_DRIVE_NO_ROOM_EXIT,
    says: (output) =>
        `There is not enough room in the sandbox "${sandbox}" for what is on ${device}, so nothing was copied. ${sentenceOf(output)}`.trim(),
});

export const networkStatus = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsNetworkStatusArgs(), failed: "ic could not say how this device is online." },
            IntenticOsNetworkStatusSchema,
        ),
    );

export const wifiList = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsWifiListArgs(), deadlineMs: SCAN_DEADLINE_MS, failed: "ic could not list the Wi-Fi networks in reach of this device." },
            IntenticOsWifiListSchema,
        ),
    );

// The password reaches ic on its stdin and nowhere else: not its argv (readable by anyone on the machine), not an error
// (icOs cuts it out of ic's output), not the audit log (mcp.ts records its length).
export const wifiConnect = async (ssid: string, password: string | undefined, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const given = password !== undefined;
    const run = await icOs(deps, {
        args: icOsWifiConnectArgs(ssid, given),
        deadlineMs: JOIN_DEADLINE_MS,
        input: password,
        failed: `This device could not join "${ssid}".`,
        refusal: wifiPassword(ssid, given),
    });
    return `${said(run, `Joined "${ssid}".`)}\n\nos_network_status says how this device is online now.`;
};

export const wifiForget = async (ssid: string, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await icOs(deps, {
        args: icOsWifiForgetArgs(ssid),
        deadlineMs: CHANGE_DEADLINE_MS,
        failed: `This device could not forget "${ssid}".`,
    });
    return `${said(run, `Forgot "${ssid}".`)}\n\nThis device will not rejoin it by itself, and joining it again takes its password.`;
};

export const wifiRadio = async (on: boolean, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await icOs(deps, {
        args: icOsWifiRadioArgs(on),
        deadlineMs: CHANGE_DEADLINE_MS,
        failed: `This device's Wi-Fi could not be turned ${on ? "on" : "off"}.`,
    });
    return on
        ? `${said(run, "Wi-Fi is on.")}\n\nA network this device knows is rejoined by itself; os_wifi_list shows what is in reach.`
        : `${said(run, "Wi-Fi is off.")}\n\nos_wifi_radio with \`on: true\`, or This computer on this machine's own screen, turns it back on.`;
};

export const soundStatus = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(await readOs(scopes, deps, { args: icOsSoundStatusArgs(), failed: "ic could not say this device's sound." }, IntenticOsSoundStatusSchema));

// Only the fields given, as the contract's argv builder takes them.
interface SoundChange {
    volume?: number;
    muted?: boolean;
}

// ic answers a change with the sound as it is after it, which is what the tool answers too.
export const soundSet = async (
    { volume, muted }: { readonly volume?: number | undefined; readonly muted?: boolean | undefined },
    scopes: DeviceScopes,
    deps: OsDeps = OS_DEPS,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const change: SoundChange = {};
    if (volume !== undefined) {
        change.volume = volume;
    }
    if (muted !== undefined) {
        change.muted = muted;
    }
    if (volume === undefined && muted === undefined) {
        throw new Error("Nothing was changed: give `volume`, `muted`, or both.");
    }
    const args = icOsSoundSetArgs(change);
    const run = await icOs(deps, { args, deadlineMs: CHANGE_DEADLINE_MS, failed: "This device's sound could not be changed." });
    return json(answerOf(run.output, IntenticOsSoundStatusSchema, args.join(" ")));
};

export const soundOutputs = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsSoundOutputsArgs(), failed: "ic could not list what plays sound on this device." },
            IntenticOsSoundOutputsSchema,
        ),
    );

export const soundOutput = async (id: number, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await icOs(deps, {
        args: icOsSoundOutputArgs(id),
        deadlineMs: CHANGE_DEADLINE_MS,
        failed: `Sound could not be moved to output ${id}.`,
    });
    return `${said(run, `Sound now plays on output ${id}.`)}\n\nos_sound_status names it.`;
};

export const displayList = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsDisplayListArgs(), failed: "ic could not list this device's screens.", refusal: NO_SCREEN },
            IntenticOsDisplayListSchema,
        ),
    );

interface DisplayChange {
    mode?: IntenticOsDisplayMode;
    scale?: number;
}

export const displaySet = async (
    output: string,
    { mode, scale }: { readonly mode?: IntenticOsDisplayMode | undefined; readonly scale?: number | undefined },
    scopes: DeviceScopes,
    deps: OsDeps = OS_DEPS,
): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const change: DisplayChange = {};
    if (mode !== undefined) {
        change.mode = mode;
    }
    if (scale !== undefined) {
        change.scale = scale;
    }
    if (mode === undefined && scale === undefined) {
        throw new Error("Nothing was changed: give `mode`, `scale`, or both.");
    }
    const run = await icOs(deps, {
        args: icOsDisplaySetArgs(output, change),
        deadlineMs: CHANGE_DEADLINE_MS,
        failed: `The screen ${output} could not be changed.`,
        refusal: NO_SCREEN,
    });
    return `${said(run, `Changed ${output}.`)}\n\nos_display_list shows it as it is now.`;
};

export const keyboardStatus = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsKeyboardStatusArgs(), failed: "ic could not say this device's keyboard layout.", refusal: NO_SCREEN },
            IntenticOsKeyboardStatusSchema,
        ),
    );

// Case and accents set aside, so "francais" finds "French" by its variants and "Français" alike.
const folded = (text: string): string => text.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();

// The layouts whose code or name `holds` says yes to: a layout it holds for with all its variants, and one it holds for
// only some variants of with those.
const layoutsWhere = (layouts: readonly IntenticOsKeyboardLayout[], holds: (code: string, name: string) => boolean): IntenticOsKeyboardLayout[] =>
    layouts.flatMap((layout) => {
        if (holds(layout.layout, layout.name)) {
            return [layout];
        }
        const variants = layout.variants.filter((variant) => holds(variant.variant, variant.name));
        return variants.length === 0 ? [] : [{ ...layout, variants }];
    });

// The layouts a search names, applied on this side since ic lists every layout xkb knows (about a hundred, some 40 KB).
// An xkb code typed whole ("de", "ch", "dvorak") means that code alone, or "de" would bring every layout "with dead
// keys"; anything else is looked for in every code and name. Pure, so the matching is asserted without an ic.
export const layoutsMatching = (layouts: readonly IntenticOsKeyboardLayout[], search: string): IntenticOsKeyboardLayout[] => {
    const wanted = folded(search.trim());
    const byCode = layoutsWhere(layouts, (code) => folded(code) === wanted);
    return byCode.length > 0 ? byCode : layoutsWhere(layouts, (code, name) => folded(code).includes(wanted) || folded(name).includes(wanted));
};

export const keyboardLayouts = async (search: string | undefined, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    const { layouts } = await readOs(
        scopes,
        deps,
        { args: icOsKeyboardLayoutsArgs(), failed: "ic could not list the keyboard layouts this device knows.", refusal: NO_SCREEN },
        IntenticOsKeyboardLayoutsSchema,
    );
    if (search === undefined || search.trim() === "") {
        return json({ layouts });
    }
    const found = layoutsMatching(layouts, search);
    return found.length === 0
        ? `No keyboard layout or variant matches "${search}". Search by a language or country ("German", "Swiss") or by an xkb code ("de", "ch"), or leave \`search\` out for all ${plural(layouts.length, "layout")}.`
        : json({ layouts: found });
};

export const keyboardSet = async (layout: string, variant: string | undefined, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const named = variant === undefined ? layout : `${layout} (${variant})`;
    const run = await icOs(deps, {
        args: icOsKeyboardSetArgs(layout, variant),
        deadlineMs: CHANGE_DEADLINE_MS,
        failed: `The keyboard layout could not be set to ${named}.`,
        refusal: NO_SCREEN,
    });
    return `${said(run, `The keyboard layout is ${named} now.`)}\n\nos_keyboard_status names it.`;
};

export const drivesList = async (scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> =>
    json(
        await readOs(
            scopes,
            deps,
            { args: icOsDrivesListArgs(), failed: "ic could not list the drives plugged into this device." },
            IntenticOsDrivesSchema,
        ),
    );

export interface DriveImportAsk {
    readonly device: string;
    readonly sandbox: string;
    // A folder inside the sandbox's /work; ic's own `/work/Imports/<label>-<date>` when unset.
    readonly path?: string | undefined;
}

// A copy that can take many minutes: no deadline, and the sandbox it lands in is marked in flight for its whole length,
// as any ic flow on a sandbox is, so no background round starts an update under it. ic prints a progress line every few
// seconds and the result last; only the result is read.
export const driveImport = async ({ device, sandbox, path }: DriveImportAsk, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const args = icOsDriveImportArgs(device, sandbox, path);
    const release = holdIcFlow(sandbox, { moves: false });
    let run: IcRun;
    try {
        run = await icOs(deps, {
            args,
            deadlineMs: undefined,
            failed: `Nothing more was copied from ${device} into "${sandbox}".`,
            refusal: noRoom(device, sandbox),
        });
    } finally {
        release();
    }
    const copied = answerOf(run.output, IntenticOsDriveImportSchema, args.join(" "));
    return `Copied ${plural(copied.files, "file")} (${sizeLabel(copied.bytes)}) from ${copied.device} into the sandbox "${copied.sandbox}", at ${copied.path}.\n\nThe drive is still plugged in: os_drive_eject before it is pulled out.`;
};

export const driveEject = async (device: string, scopes: DeviceScopes, deps: OsDeps = OS_DEPS): Promise<string> => {
    assertScope(scopes, "sandboxes");
    const run = await icOs(deps, {
        args: icOsDriveEjectArgs(device),
        deadlineMs: EJECT_DEADLINE_MS,
        failed: `${device} could not be ejected. Do not pull it out yet.`,
    });
    return `${said(run, `Ejected ${device}.`)}\n\nIt can be pulled out now.`;
};

// A Wi-Fi password is one line, and reaches ic on stdin and nowhere else. A refusal of it names the rule broken, never
// the value (zod's messages do not quote a string's input), and the audit log records only its length (mcp.ts).
const WifiPasswordSchema = z
    .string()
    .min(1)
    .max(128)
    .refine((password) => !/[\r\n]/.test(password), "a Wi-Fi password is one line");

const SEEING = "Requires 'Run commands' or 'Manage sandboxes on this device'.";
const MANAGING = "Requires the 'Manage sandboxes on this device' permission.";

// The tools, in the voice of the OS tools beside them: what each reads or changes, what to call first, and, for the two
// that can take this machine off its network, that the caller's own link goes with it. Grouped by what they change,
// first Wi-Fi and how the device is online.
const NETWORK_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    tool({
        name: "os_network_status",
        description: `How this device is online right now, as JSON from its \`ic os network status\`: \`connected\`, \`kind\` (wifi, ethernet or none), \`name\` (the Wi-Fi network's or the wired connection's) and \`signal\` (Wi-Fi strength 0-100, null on a wire). Changes nothing: call it before any Wi-Fi change. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await networkStatus(scopes, deps)),
    }),
    tool({
        name: "os_wifi_list",
        description: `The Wi-Fi networks in reach of this device, as JSON from its \`ic os network wifi list\`, after a fresh scan of a few seconds: each network once, strongest first, with its \`signal\` (0-100), whether it asks for a password (\`secured\`), whether this device has joined it before and rejoins it by itself (\`known\`) and whether it is the one in use (\`active\`). \`adapter\` false means this device has no Wi-Fi; \`enabled\` false means Wi-Fi is turned off (os_wifi_radio). Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await wifiList(scopes, deps)),
    }),
    tool({
        name: "os_wifi_connect",
        description: `Join a Wi-Fi network by its name (\`ssid\`, as os_wifi_list gives it) through this device's \`ic os network wifi connect\`. A known network, or one that asks for no password, needs none. One that needs a password this device does not know is refused, saying so: never ask the owner to type a password into chat, where it stays in the transcript. Ask them to join it from This computer on this machine's own screen, or pass \`password\` only when you have it some way that leaves no copy in the conversation. It reaches ic on stdin, never a command line, and this device's audit log keeps only its length. While the device switches networks its connection drops for a moment. ${MANAGING}`,
        effect: "write",
        input: z.object({
            ssid: IntenticOsSsidSchema.describe("The network's name, exactly as os_wifi_list gives it."),
            password: WifiPasswordSchema.optional().describe("Only for a network that asks for one this device does not know yet."),
        }),
        run: async ({ ssid, password }, scopes) => textResult(await wifiConnect(ssid, password, scopes, deps)),
    }),
    tool({
        name: "os_wifi_forget",
        description: `Forget a Wi-Fi network this device has joined before (\`known\` in os_wifi_list), through its \`ic os network wifi forget\`: it stops rejoining it by itself, and joining it again takes the password. Forgetting the network in use takes this device off it, and when Wi-Fi is how it is online (os_network_status) that cuts every sandbox here off from the internet, your own model included, until someone at the machine joins a network again: get the owner's yes in chat first. ${MANAGING}`,
        effect: "write",
        input: z.object({ ssid: IntenticOsSsidSchema.describe("The network's name, exactly as os_wifi_list gives it.") }),
        run: async ({ ssid }, scopes) => textResult(await wifiForget(ssid, scopes, deps)),
    }),
    tool({
        name: "os_wifi_radio",
        description: `Turn this device's Wi-Fi on or off, through its \`ic os network wifi on|off\`. Turned on, it rejoins a network it knows by itself. Turned off while Wi-Fi is how this device is online (os_network_status), it cuts every sandbox here off from the internet, your own model included, so nothing on this side could turn it back on: only someone at the machine can. Get the owner's yes in chat before turning it off. ${MANAGING}`,
        effect: "write",
        input: z.object({ on: z.boolean().describe("true turns Wi-Fi on, false turns it off.") }),
        run: async ({ on }, scopes) => textResult(await wifiRadio(on, scopes, deps)),
    }),
];

// The volume, mute and where sound plays.
const SOUND_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    tool({
        name: "os_sound_status",
        description: `This device's sound, as JSON from its \`ic os sound status\`: the \`volume\` of what plays now (0-100), whether it is \`muted\`, and the speaker or headphones it plays on (\`output\`, null when there are none). Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await soundStatus(scopes, deps)),
    }),
    tool({
        name: "os_sound_set",
        description: `Set this device's volume, mute or unmute it, or both, through its \`ic os sound set\`, and answer with the sound as it is after (os_sound_status's JSON). ${MANAGING}`,
        effect: "write",
        input: z.object({
            volume: z.number().min(0).max(100).optional().describe("The volume, 0-100."),
            muted: z.boolean().optional().describe("true mutes, false unmutes."),
        }),
        run: async ({ volume, muted }, scopes) => textResult(await soundSet({ volume, muted }, scopes, deps)),
    }),
    tool({
        name: "os_sound_outputs",
        description: `Every speaker, headphone and screen that can play this device's sound, as JSON from its \`ic os sound outputs\`: each with the \`id\` os_sound_output takes, its \`name\`, and \`default\` on the one in use. An id can change when a device is plugged in again, so list before you switch. Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await soundOutputs(scopes, deps)),
    }),
    tool({
        name: "os_sound_output",
        description: `Play this device's sound on another speaker, headphones or screen, by its \`id\` from os_sound_outputs, through its \`ic os sound output\`. ${MANAGING}`,
        effect: "write",
        input: z.object({ id: z.number().int().nonnegative().describe("The output's id, from os_sound_outputs.") }),
        run: async ({ id }, scopes) => textResult(await soundOutput(id, scopes, deps)),
    }),
];

// The screens and the keyboard (desktop edition).
const SCREEN_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    tool({
        name: "os_display_list",
        description: `This device's screens, as JSON from its \`ic os display list\`: each by its connector \`name\` (\`eDP-1\`, \`HDMI-A-1\`), what it says it is (\`make\`, \`model\`), whether it is \`enabled\`, the mode it shows now (\`current\`: width, height and refresh in Hz), every mode it offers (\`modes\`) and its \`scale\`. The server edition has no screen and says so. Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await displayList(scopes, deps)),
    }),
    tool({
        name: "os_display_set",
        description: `Change one of this device's screens through its \`ic os display set\`: its \`mode\` (one of its \`modes\` in os_display_list, as given there), its \`scale\` (how much bigger everything is drawn, 0.5-4), or both. It changes what the person at the machine sees at once, so say what you are changing. ${MANAGING}`,
        effect: "write",
        input: z.object({
            output: IntenticOsDisplayNameSchema.describe("The screen's connector name, from os_display_list."),
            mode: IntenticOsDisplayModeSchema.optional().describe("One of the screen's modes, exactly as os_display_list gives it."),
            scale: IntenticOsScaleSchema.optional().describe("1 for none, 2 for twice the size; 0.5-4."),
        }),
        run: async ({ output, mode, scale }, scopes) => textResult(await displaySet(output, { mode, scale }, scopes, deps)),
    }),
    tool({
        name: "os_keyboard_status",
        description: `This device's keyboard layout, as JSON from its \`ic os keyboard status\`: the \`layout\` as xkb names it (\`us\`, \`de\`), its \`variant\` (null for the layout's own) and its \`name\` for a person ("German (no dead keys)"). The server edition has no screen and says so. Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await keyboardStatus(scopes, deps)),
    }),
    tool({
        name: "os_keyboard_layouts",
        description: `The keyboard layouts this device knows, as JSON from its \`ic os keyboard layouts\`, each with its variants. There are about a hundred, so give \`search\`: a language or country ("German", "Swiss") or an xkb code ("de", "ch"), case and accents aside. A layout it matches comes with all its variants, and one only some of whose variants match comes with those. Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({
            search: z.string().max(100).optional().describe("Part of a layout's or variant's name or xkb code. Leave it out for every layout."),
        }),
        run: async ({ search }, scopes) => textResult(await keyboardLayouts(search, scopes, deps)),
    }),
    tool({
        name: "os_keyboard_set",
        description: `Set this device's keyboard layout through its \`ic os keyboard set\`: a \`layout\` and optionally a \`variant\`, each as os_keyboard_layouts names it. It changes what every key the person at the machine presses types, at once and for every program. ${MANAGING}`,
        effect: "write",
        input: z.object({
            layout: IntenticOsXkbNameSchema.describe("The layout's xkb code, like de."),
            variant: IntenticOsXkbNameSchema.optional().describe("The variant's xkb code, like nodeadkeys. Leave it out for the layout's own."),
        }),
        run: async ({ layout, variant }, scopes) => textResult(await keyboardSet(layout, variant, scopes, deps)),
    }),
];

// USB drives and memory cards.
const DRIVE_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    tool({
        name: "os_drives_list",
        description: `The removable drives plugged into this device (USB sticks and disks, memory cards), as JSON from its \`ic os drives list\`: each filesystem's \`device\` (what os_drive_import and os_drive_eject take), \`label\`, \`size\` in bytes, \`filesystem\`, where it is open (\`mountedAt\`, null while it is not), \`readOnly\`, \`model\` and \`kind\`. The machine's own disks are never listed. Changes nothing. ${SEEING}`,
        effect: "read",
        input: z.object({}),
        run: async (_args, scopes) => textResult(await drivesList(scopes, deps)),
    }),
    tool({
        name: "os_drive_import",
        description: `Copy everything on a removable drive into a sandbox on this device, through its \`ic os drives import\`: it lands in that sandbox's /work/Imports/<label>-<date>, or in \`path\` inside its /work, and nothing on the drive is changed. A big drive takes many minutes, and the call returns when the copy is done, with how many files and bytes it copied and where. When it would not fit nothing is copied, and it says so. The sandbox is usually the one asking ("copy the stick into my sandbox"); confirm with the owner in chat before copying into any other. ${MANAGING}`,
        effect: "write",
        input: z.object({
            device: IntenticOsBlockDeviceSchema.describe("The drive's device, from os_drives_list, like /dev/sdb1."),
            sandbox: IntenticOsSandboxSlugSchema.describe("The slug of the sandbox to copy into, from list_sandboxes."),
            path: IntenticOsImportPathSchema.optional().describe(
                "A folder inside the sandbox's /work, like Photos/2026. Leave it out for /work/Imports/<label>-<date>.",
            ),
        }),
        run: async ({ device, sandbox, path }, scopes) => textResult(await driveImport({ device, sandbox, path }, scopes, deps)),
    }),
    tool({
        name: "os_drive_eject",
        description: `Eject a removable drive so it can be pulled out safely, through this device's \`ic os drives eject\`: whatever is still being written to it is finished first, then it is closed. Confirm with the owner in chat first unless they asked for it: a program or a copy still reading from it loses it. ${MANAGING}`,
        effect: "write",
        input: z.object({ device: IntenticOsBlockDeviceSchema.describe("The drive's device, from os_drives_list, like /dev/sdb1.") }),
        run: async ({ device }, scopes) => textResult(await driveEject(device, scopes, deps)),
    }),
];

const SETTINGS_TOOLS = (deps: OsDeps): McpTool<DeviceScopes>[] => [
    ...NETWORK_TOOLS(deps),
    ...SOUND_TOOLS(deps),
    ...SCREEN_TOOLS(deps),
    ...DRIVE_TOOLS(deps),
];

/** The settings tools, on a machine that is Intentic OS (its release.json exists) and nowhere else, like osTools. */
export const osSettingsTools = (release: string = INTENTIC_OS_RELEASE_PATH, deps: OsDeps = OS_DEPS): McpTool<DeviceScopes>[] =>
    existsSync(release) ? SETTINGS_TOOLS(deps) : [];
