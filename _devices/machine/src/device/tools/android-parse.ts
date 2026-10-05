import { posix, win32 } from "node:path";
import type { Point, Rect } from "@intentic/desktop-automation";
import { inertRegions, isLive } from "@intentic/sandbox-contract";

/* What adb prints, read into values, and what the phone is sent, spelled from values: nothing here runs a program, so
   every rule below is tested on text alone. android.ts runs adb and decides what is allowed. */

// A sentence an Android tool answers with instead of a result: adb missing, no phone, a phone not ready, an argument
// the phone cannot take. A tool failure, not a refused switch.
export class AndroidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AndroidError";
    }
}

// --- finding adb -----------------------------------------------------------------------------------------------------

// Where adb may be, in the order it is looked for: the SDK the environment names, the SDK Android Studio installs by
// default, then PATH.
export const adbCandidates = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] => {
    const path = platform === "win32" ? win32 : posix;
    const exe = platform === "win32" ? "adb.exe" : "adb";
    const localAppData = env["LOCALAPPDATA"];
    const studioSdk =
        platform === "win32"
            ? localAppData === undefined
                ? undefined
                : path.join(localAppData, "Android", "Sdk")
            : platform === "darwin"
              ? path.join(home, "Library", "Android", "sdk")
              : path.join(home, "Android", "Sdk");
    const sdks = [env["ANDROID_HOME"], env["ANDROID_SDK_ROOT"], studioSdk].filter((sdk): sdk is string => sdk !== undefined && sdk !== "");
    const onPath = (env["PATH"] ?? env["Path"] ?? "")
        .split(path.delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => path.join(dir, exe));
    return [...new Set([...sdks.map((sdk) => path.join(sdk, "platform-tools", exe)), ...onPath])];
};

export const findAdb = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, exists: (path: string) => boolean): string | undefined =>
    adbCandidates(env, platform, home).find(exists);

const INSTALL_HINT = new Map<NodeJS.Platform, string>([
    ["win32", "`winget install Google.PlatformTools`"],
    ["linux", "`sudo apt install adb` on Debian or Ubuntu"],
    ["darwin", "`brew install --cask android-platform-tools`"],
]);

export const adbMissing = (platform: NodeJS.Platform): string => {
    const hint = INSTALL_HINT.get(platform);
    return (
        `adb is not installed on this computer, so no Android phone can be reached from it: install Android SDK Platform-Tools ` +
        `(${hint === undefined ? "" : `${hint}, or `}the zip from https://developer.android.com/tools/releases/platform-tools) ` +
        `and put it on PATH or set ANDROID_HOME, then try again.`
    );
};

// --- adb devices -l --------------------------------------------------------------------------------------------------

export type AndroidTransport = "usb" | "wireless" | "emulator";

export interface AndroidDevice {
    readonly serial: string;
    // adb's own word: "device" is ready; "unauthorized", "offline", "no permissions", "recovery", "sideload"… are not.
    readonly state: string;
    // As adb names it, with its underscores read back as spaces; undefined where adb did not say.
    readonly model: string | undefined;
    readonly product: string | undefined;
    readonly transport: AndroidTransport;
}

// adb writes a model with spaces as underscores ("Pixel_7_Pro"); a person reads it with the spaces.
const spaced = (value: string | undefined): string | undefined => value?.replace(/_/g, " ");

const transportOf = (serial: string): AndroidTransport =>
    /^emulator-\d+$/.test(serial) ? "emulator" : /:\d+$/.test(serial) || serial.includes("._adb-tls-connect._tcp") ? "wireless" : "usb";

// `adb devices -l`, one device per line after the header. The daemon's own start-up lines ("* daemon started") and the
// header are skipped; "no permissions" is the one state with a space in it, followed by a sentence of adb's own.
export const parseAdbDevices = (output: string): AndroidDevice[] =>
    output.split(/\r?\n/).flatMap((line) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("*") || trimmed.startsWith("List of devices") || /^adb(?:\.exe)?[: ]/.test(trimmed)) {
            return [];
        }
        const match = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(trimmed);
        if (match === null) {
            return [];
        }
        const [, serial = "", state = "", rest = ""] = match;
        const fields = new Map([...rest.matchAll(/\b(model|product):(\S+)/g)].map((field) => [field[1], field[2]]));
        return [{ serial, state, model: spaced(fields.get("model")), product: fields.get("product"), transport: transportOf(serial) }];
    });

// What a state that is not "device" means, as something the person holding the phone can do about it.
export const stateNote = (state: string): string | undefined => {
    switch (state) {
        case "device":
            return undefined;
        case "unauthorized":
            return `the phone has not trusted this computer yet: unlock it and accept the "Allow USB debugging?" prompt on the phone (tick "Always allow from this computer").`;
        case "authorizing":
            return "the phone is still deciding whether to trust this computer: accept the prompt on the phone.";
        case "offline":
            return "adb lost the phone: unplug and replug it (or `adb reconnect`), or turn USB debugging off and on again.";
        case "no permissions":
            return "this computer's user may not open the phone's USB device: add a udev rule for it, or the user to the plugdev group, then replug it.";
        case "connecting":
            return "adb is still connecting to it: wait a moment and list the devices again.";
        default:
            return `it is in ${state} mode, not running Android: reboot it normally first.`;
    }
};

const named = (device: AndroidDevice): string => (device.model === undefined ? device.serial : `${device.serial} (${device.model})`);

export const NO_DEVICE =
    "No Android phone is attached to this computer. Plug it in by USB with USB debugging on (Settings > Developer options), " +
    "or for wireless debugging pair it once with `adb pair <ip>:<pairing port>` and the code the phone shows, then `adb connect <ip>:<port>`.";

// The one device the call is about: the named serial, or the only one attached. Several attached and none named is
// refused, since acting on the wrong phone is the one mistake nothing here can see.
export const chooseDevice = (devices: readonly AndroidDevice[], serial: string | undefined): AndroidDevice => {
    const listed = devices.map((device) => `${named(device)}: ${device.state === "device" ? "ready" : device.state}`).join("; ");
    const chosen = serial === undefined ? (devices.length === 1 ? devices[0] : undefined) : devices.find((device) => device.serial === serial);
    if (chosen === undefined) {
        if (devices.length === 0) {
            throw new AndroidError(serial === undefined ? NO_DEVICE : `No Android device "${serial}" is attached. ${NO_DEVICE}`);
        }
        throw new AndroidError(
            serial === undefined
                ? `${devices.length} Android devices are attached (${listed}): pass \`serial\` to say which one.`
                : `No Android device "${serial}" is attached; attached: ${listed}.`,
        );
    }
    const note = stateNote(chosen.state);
    if (note !== undefined) {
        throw new AndroidError(`${named(chosen)} is attached but not ready (${chosen.state}): ${note}`);
    }
    return chosen;
};

// --- getprop and wm size -----------------------------------------------------------------------------------------------

export interface ScreenSize {
    readonly width: number;
    readonly height: number;
}

// `wm size`: the physical size, and an override when one is set, which is what the screen actually draws at. Both in
// the phone's natural orientation.
export const parseWmSize = (output: string): ScreenSize | undefined => {
    const read = (label: string): ScreenSize | undefined => {
        const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`).exec(output);
        return match === null ? undefined : { width: Number(match[1]), height: Number(match[2]) };
    };
    return read("Override") ?? read("Physical");
};

// The natural size turned to the rotation the screen is in: a quarter turn swaps the sides.
export const rotated = (size: ScreenSize, rotation: number): ScreenSize => (rotation % 2 === 1 ? { width: size.height, height: size.width } : size);

// --- uiautomator dump --------------------------------------------------------------------------------------------------

export interface AndroidNode {
    readonly parent: number | undefined;
    readonly text: string;
    readonly desc: string;
    readonly resourceId: string;
    readonly className: string;
    readonly packageName: string;
    readonly clickable: boolean;
    readonly longClickable: boolean;
    readonly focusable: boolean;
    readonly focused: boolean;
    readonly scrollable: boolean;
    readonly checkable: boolean;
    readonly checked: boolean;
    readonly enabled: boolean;
    readonly selected: boolean;
    readonly password: boolean;
    readonly bounds: Rect;
}

export interface AndroidHierarchy {
    // Quarter turns from the natural orientation, 0–3.
    readonly rotation: number;
    readonly nodes: readonly AndroidNode[];
}

const ENTITIES = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
]);

const unescapeXml = (text: string): string =>
    text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
        if (entity.startsWith("#x")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith("#")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return ENTITIES.get(entity) ?? whole;
    });

const attributesOf = (source: string): Map<string, string> =>
    new Map([...source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1] ?? "", unescapeXml(match[2] ?? "")]));

const boundsOf = (value: string | undefined): Rect => {
    const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? "");
    if (match === null) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    // SAFETY: the pattern has exactly four groups, and a match fills every one of them.
    const [left, top, right, bottom] = match.slice(1).map(Number) as [number, number, number, number];
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

// The first line uiautomator printed that is not XML: what it says when it could not read the screen.
const complaintOf = (output: string): string =>
    output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "" && !line.startsWith("<")) ?? "it printed nothing";

// A dump's XML, read with nothing but the patterns of the one serializer that writes it: double-quoted attributes on
// `node` elements nested inside one `hierarchy`. Whatever is printed around it ("UI hierchary dumped to: /dev/tty")
// is ignored; output with no hierarchy in it is refused with what uiautomator said instead.
export const parseUiDump = (output: string): AndroidHierarchy => {
    const start = output.indexOf("<hierarchy");
    const end = output.lastIndexOf("</hierarchy>");
    if (start === -1) {
        throw new AndroidError(`uiautomator could not read the phone's screen (${complaintOf(output)}).`);
    }
    const xml = output.slice(start, end === -1 ? undefined : end + "</hierarchy>".length);
    const rotation = Number(/<hierarchy\b[^>]*\brotation="(\d)"/.exec(xml)?.[1] ?? 0);
    const nodes: AndroidNode[] = [];
    const open: number[] = [];
    for (const tag of xml.matchAll(/<(\/?)node\b((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
        if (tag[1] === "/") {
            open.pop();
            continue;
        }
        const attributes = attributesOf(tag[2] ?? "");
        const flag = (name: string): boolean => attributes.get(name) === "true";
        nodes.push({
            parent: open.at(-1),
            text: attributes.get("text") ?? "",
            desc: attributes.get("content-desc") ?? "",
            resourceId: attributes.get("resource-id") ?? "",
            className: attributes.get("class") ?? "",
            packageName: attributes.get("package") ?? "",
            clickable: flag("clickable"),
            longClickable: flag("long-clickable"),
            focusable: flag("focusable"),
            focused: flag("focused"),
            scrollable: flag("scrollable"),
            checkable: flag("checkable"),
            checked: flag("checked"),
            enabled: attributes.get("enabled") !== "false",
            selected: flag("selected"),
            password: flag("password"),
            bounds: boundsOf(attributes.get("bounds")),
        });
        if (tag[3] !== "/") {
            open.push(nodes.length - 1);
        }
    }
    return { rotation, nodes };
};

// --- elements ----------------------------------------------------------------------------------------------------------

export interface PhoneElement {
    readonly ref: string;
    readonly node: AndroidNode;
    // Its own text or description, or for a control with neither, what its contents say.
    readonly label: string;
    readonly labelFromContents: boolean;
    // The centre of its bounds, in the phone's own pixels: where a tap on it lands.
    readonly center: Point;
}

const isEditable = (node: AndroidNode): boolean => /EditText|AutoCompleteTextView/.test(node.className);

const operable = (node: AndroidNode): boolean => node.clickable || node.longClickable || node.scrollable || node.checkable || isEditable(node);

const ownLabel = (node: AndroidNode): string => (node.text !== "" ? node.text : node.desc);

// A control a person presses as one thing (a list row, a card) is called by the words inside it; a scrolling container
// is not, or the first lines of the list would be folded into its name and left off the listing.
const namedByContents = (node: AndroidNode): boolean => (node.clickable || node.longClickable || node.checkable) && !node.scrollable;

// Past this a listing stops being a list anybody reads; `query` narrows it instead.
export const MAX_SHOWN = 150;

const centre = (bounds: Rect): Point => ({ x: Math.floor(bounds.x + bounds.width / 2), y: Math.floor(bounds.y + bounds.height / 2) });

/* What a person could operate or read on the screen, in reading order, each with a ref. A control with no words of
   its own (a list row, a card) is named by the first words inside it, and those words are then not listed again on
   their own lines. Nodes with no place on the screen are left out. With a query, every node whose text, description,
   id or class contains it, operable or not. */
export interface PhoneListing {
    // The elements shown, at most MAX_SHOWN, refs counting from e1.
    readonly elements: PhoneElement[];
    // How many there were before the cap.
    readonly total: number;
}

export const phoneElements = (hierarchy: AndroidHierarchy, query: string | undefined): PhoneListing => {
    const { nodes } = hierarchy;
    const visible = (node: AndroidNode): boolean => node.bounds.width > 0 && node.bounds.height > 0;
    const children = new Map<number, number[]>();
    nodes.forEach((node, index) => {
        if (node.parent !== undefined) {
            children.set(node.parent, [...(children.get(node.parent) ?? []), index]);
        }
    });
    const wordsInside = (index: number): number[] =>
        (children.get(index) ?? []).flatMap((child) => {
            const node = nodes[child];
            return node === undefined || !visible(node) ? [] : ownLabel(node) === "" ? wordsInside(child) : [child];
        });
    const covered = new Set<number>();
    const labels = new Map<number, { readonly label: string; readonly fromContents: boolean }>();
    nodes.forEach((node, index) => {
        if (ownLabel(node) !== "") {
            labels.set(index, { label: ownLabel(node), fromContents: false });
        } else if (namedByContents(node)) {
            const inside = wordsInside(index)
                .slice(0, 3)
                .flatMap((child) => {
                    const word = nodes[child];
                    return word === undefined ? [] : [{ child, label: ownLabel(word) }];
                });
            inside.forEach(({ child }) => covered.add(child));
            labels.set(index, { label: inside.map(({ label }) => label).join(" · "), fromContents: inside.length > 0 });
        }
    });
    const wanted = query?.trim().toLowerCase() ?? "";
    const chosen = nodes.flatMap((node, index) => {
        if (!visible(node)) {
            return [];
        }
        const keep =
            wanted === ""
                ? // An icon with no words is still listed when it has an id to tell it by.
                  (operable(node) && ((labels.get(index)?.label ?? "") !== "" || node.resourceId !== "" || isEditable(node) || node.scrollable)) ||
                  (ownLabel(node) !== "" && !covered.has(index))
                : [node.text, node.desc, node.resourceId, node.className].some((field) => field.toLowerCase().includes(wanted));
        return keep ? [index] : [];
    });
    const elements = chosen.slice(0, MAX_SHOWN).flatMap((index, position) => {
        const node = nodes[index];
        const label = labels.get(index) ?? { label: "", fromContents: false };
        return node === undefined
            ? []
            : [{ ref: `e${position + 1}`, node, label: label.label, labelFromContents: label.fromContents, center: centre(node.bounds) }];
    });
    return { elements, total: chosen.length };
};

const quoted = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);

const shortClass = (className: string): string => className.slice(className.lastIndexOf(".") + 1) || "View";

const shortId = (resourceId: string): string => {
    const at = resourceId.indexOf(":id/");
    return at === -1 ? resourceId : resourceId.slice(at + 4);
};

// What a node is doing or offers, in the words a listing puts in brackets after it.
const statesOf = (node: AndroidNode): string[] =>
    [
        node.clickable ? "clickable" : "",
        node.longClickable ? "long-clickable" : "",
        isEditable(node) || (node.focusable && !node.clickable) ? "focusable" : "",
        node.scrollable ? "scrollable" : "",
        node.checkable ? (node.checked ? "checked" : "unchecked") : "",
        node.focused ? "focused" : "",
        node.selected ? "selected" : "",
        node.password ? "password" : "",
        node.enabled ? "" : "disabled",
    ].filter((state) => state !== "");

const wordsOf = (element: PhoneElement): string => {
    if (element.label === "") {
        return "";
    }
    return element.labelFromContents ? ` contains ${quoted(element.label)}` : ` ${quoted(element.label)}`;
};

// One element as a line of a listing; `at` is where its centre falls in a screenshot, already placed by the caller.
export const describeElement = (element: PhoneElement, at: Point): string => {
    const { node } = element;
    const desc = node.text !== "" && node.desc !== "" && node.desc !== node.text ? ` desc=${quoted(node.desc)}` : "";
    const id = node.resourceId === "" ? "" : ` id=${shortId(node.resourceId)}`;
    const states = statesOf(node);
    return `${element.ref} ${shortClass(node.className)}${wordsOf(element)}${desc}${id} at ${at.x},${at.y}${states.length === 0 ? "" : ` [${states.join(" ")}]`}`;
};

// --- input ---------------------------------------------------------------------------------------------------------------

// The phone's sh reads the command adb hands it: one argument, single-quoted, means exactly its characters.
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

// The control characters a keyboard has a key for: Enter for a line break, Tab for a tab.
const KEY_FOR_CONTROL = new Map([
    ["\n", "66"],
    ["\r", "66"],
    ["\t", "61"],
]);

const codePoint = (char: string): string => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

const assertAscii = (char: string): void => {
    if (char < " " || char > "~") {
        throw new AndroidError(
            `Android's \`input text\` types plain ASCII only, and this text holds ${JSON.stringify(char)} (${codePoint(char)}), which it cannot carry. ` +
                `Type the ASCII parts, and enter the rest by tapping the phone's own keyboard.`,
        );
    }
};

// Text split into runs one `input text` call carries and the keys pressed between them.
type TypedPart = { readonly kind: "text"; readonly text: string } | { readonly kind: "key"; readonly code: string };

const typedParts = (text: string): TypedPart[] => {
    const parts: TypedPart[] = [];
    let run = "";
    const flush = (): void => {
        if (run !== "") {
            parts.push({ kind: "text", text: run });
        }
        run = "";
    };
    // "\r\n" is one Enter, not two.
    const chars = [...text.replace(/\r\n/g, "\n")];
    chars.forEach((char, index) => {
        const code = KEY_FOR_CONTROL.get(char);
        if (code !== undefined) {
            flush();
            parts.push({ kind: "key", code });
            return;
        }
        assertAscii(char);
        // `input text` reads "%s" as a space, so a literal one is split across two calls.
        if (char === "s" && chars[index - 1] === "%") {
            flush();
        }
        run += char;
    });
    flush();
    return parts;
};

/* The phone-side commands that type `text`, joined with `&&` so a failure stops the rest. Android's `input text` types
   printable ASCII only, reads "%s" as a space (which is how a space survives it), and takes one argument: so a space is
   sent as %s, a literal "%" followed by "s" is split across two calls so it is not read as one, a newline or tab is
   pressed as its key, and anything else (accents, emoji, other control characters) is refused by name rather than
   typed as something else. */
export const inputTextCommand = (text: string): string => {
    const parts = typedParts(text);
    if (parts.length === 0) {
        throw new AndroidError(`"text" is required to type, and it has nothing in it to type.`);
    }
    return parts
        .map((part) => (part.kind === "key" ? `input keyevent ${part.code}` : `input text ${shellQuote(part.text.replace(/ /g, "%s"))}`))
        .join(" && ");
};

// The keys that turn the screen off or put the phone to sleep: from there a PIN stands between the phone and anything
// driving it from here. By name and by number, since `input keyevent` takes either.
const LOCK_KEYS: ReadonlyMap<string, string> = new Map([
    ["KEYCODE_POWER", "26"],
    ["KEYCODE_SLEEP", "223"],
    ["KEYCODE_SOFT_SLEEP", "276"],
    ["KEYCODE_TV_POWER", "177"],
    ["KEYCODE_STB_POWER", "179"],
    ["KEYCODE_AVR_POWER", "181"],
]);
const LOCK_NUMBERS: ReadonlyMap<string, string> = new Map([...LOCK_KEYS].map(([name, code]) => [code, name]));

const lockoutRefusal = (key: string): AndroidError =>
    new AndroidError(
        `Refused: ${key} turns the phone's screen off and locks it, and nothing driving it from here can unlock it again. Ask the user to do it themselves.`,
    );

// The names a desktop key goes by, as the Android key code they press.
const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
    ["return", "KEYCODE_ENTER"],
    ["enter", "KEYCODE_ENTER"],
    ["backspace", "KEYCODE_DEL"],
    ["delete", "KEYCODE_FORWARD_DEL"],
    ["tab", "KEYCODE_TAB"],
    ["escape", "KEYCODE_ESCAPE"],
    ["esc", "KEYCODE_ESCAPE"],
    ["space", "KEYCODE_SPACE"],
    ["up", "KEYCODE_DPAD_UP"],
    ["down", "KEYCODE_DPAD_DOWN"],
    ["left", "KEYCODE_DPAD_LEFT"],
    ["right", "KEYCODE_DPAD_RIGHT"],
    ["page_up", "KEYCODE_PAGE_UP"],
    ["page_down", "KEYCODE_PAGE_DOWN"],
    ["recents", "KEYCODE_APP_SWITCH"],
]);

// One key as `input keyevent` takes it: a KEYCODE_ name (with or without the prefix, any case), a desktop name like
// "Return", or a number. Keys that lock the phone are refused, as the desktop refuses super+l.
export const keyEventFor = (key: string): string => {
    const trimmed = key.trim();
    if (/^\d+$/.test(trimmed)) {
        const name = LOCK_NUMBERS.get(String(Number(trimmed)));
        if (name !== undefined) {
            throw lockoutRefusal(`${trimmed} (${name})`);
        }
        return String(Number(trimmed));
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
        throw new AndroidError(
            `"${key}" is not an Android key: use a key code name like KEYCODE_ENTER (or ENTER, Return, BACK, VOLUME_UP), or its number.`,
        );
    }
    const name =
        KEY_ALIASES.get(trimmed.toLowerCase()) ??
        (trimmed.toUpperCase().startsWith("KEYCODE_") ? trimmed.toUpperCase() : `KEYCODE_${trimmed.toUpperCase()}`);
    if (LOCK_KEYS.has(name)) {
        throw lockoutRefusal(name);
    }
    return name;
};

// `input keyevent` with a lock key inside a shell command: the spelling that would get past android_act's refusal.
export const assertNoLockoutCommand = (command: string): void => {
    for (const match of command.matchAll(/\binput\b[^;&|\n]*?\bkeyevent\b([^;&|\n]*)/g)) {
        for (const word of (match[1] ?? "").split(/\s+/).filter((part) => part !== "" && !part.startsWith("-"))) {
            const bare = word.replace(/^['"]|['"]$/g, "");
            const upper = bare.toUpperCase();
            const name = /^\d+$/.test(bare)
                ? LOCK_NUMBERS.get(String(Number(bare)))
                : LOCK_KEYS.has(upper)
                  ? upper
                  : LOCK_KEYS.has(`KEYCODE_${upper}`)
                    ? `KEYCODE_${upper}`
                    : undefined;
            if (name !== undefined) {
                throw lockoutRefusal(`input keyevent ${bare} (${name})`);
            }
        }
    }
};

// --- what a phone-side command would do ------------------------------------------------------------------------------

// Where a command word starts: the beginning, after a separator or a substitution, past a wrapper that runs what
// follows (`su -c`, `toybox`, `exec`…).
const AT_COMMAND = String.raw`(?:^|[;&|(\n\`]|\$\()\s*(?:(?:su(?:\s+\w+)?\s+-c|toybox|busybox|exec|nohup|command|timeout\s+\S+)\s+['"]?)*`;

/* What on a phone needs "Run destructive commands" beyond what the shared classifier already reads (`rm -rf`, `find
   -delete`, a wiped block device): each loses something the phone does not give back, or cuts the link this is
   driven over (`svc wifi disable` over wireless debugging). Read only where the phone's shell would run it. */
const ANDROID_DESTRUCTIVE: readonly { readonly pattern: RegExp; readonly label: string }[] = [
    { pattern: /\b(?:pm|cmd\s+package)\s+uninstall\b/g, label: "uninstall an app" },
    { pattern: /\b(?:pm|cmd\s+package)\s+clear\b/g, label: "clear an app's data" },
    {
        pattern: new RegExp(`${AT_COMMAND}rm\\s+(?:-{1,2}[\\w-]+\\s+)*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`, "g"),
        label: "delete files recursively",
    },
    { pattern: /\bsettings\s+(?:put|delete|reset)\b/g, label: "change a system setting" },
    { pattern: new RegExp(`${AT_COMMAND}svc\\s+\\w+`, "g"), label: "switch a phone service (svc), which can cut off its network or this link" },
    { pattern: new RegExp(`${AT_COMMAND}reboot\\b`, "g"), label: "reboot the phone" },
    { pattern: new RegExp(`${AT_COMMAND}wipe\\b|--wipe_data\\b|\\bMASTER_CLEAR\\b|\\bFACTORY_RESET\\b`, "g"), label: "wipe the phone's data" },
];

// What `command` would do on the phone that needs the destructive switch, as the words a refusal names, empty for
// ordinary work.
export const androidDestructive = (command: string): string[] => {
    const regions = inertRegions(command);
    return ANDROID_DESTRUCTIVE.filter(({ pattern }) =>
        [...command.matchAll(pattern)].some((match) => {
            // The pattern may start on the separator before the word; the word itself is what has to be live.
            const offset = match[0].search(/\S/) === -1 ? 0 : match[0].search(/[A-Za-z-]/);
            const start = match.index + Math.max(0, offset);
            return isLive({ start, end: start + 1 }, regions);
        }),
    ).map(({ label }) => label);
};
