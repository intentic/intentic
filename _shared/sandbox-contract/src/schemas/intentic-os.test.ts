import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DeviceFactsSchema } from "./hosts.js";
import {
    displayModeArg,
    IC_OS_DRIVE_NO_ROOM_EXIT,
    IC_OS_NO_SCREEN_EXIT,
    IC_OS_NOT_INTENTIC_OS_EXIT,
    IC_OS_WIFI_PASSWORD_EXIT,
    icOsChannelArgs,
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
    IntenticOsDisplayListSchema,
    IntenticOsDriveImportProgressSchema,
    IntenticOsDriveImportSchema,
    IntenticOsDrivesSchema,
    IntenticOsKeyboardLayoutsSchema,
    IntenticOsKeyboardStatusSchema,
    IntenticOsNetworkStatusSchema,
    IntenticOsSoundOutputsSchema,
    IntenticOsSoundStatusSchema,
    IntenticOsWifiListSchema,
    icOsRebootArgs,
    icOsRollbackArgs,
    icOsStatusArgs,
    icOsUpdateArgs,
    type IntenticOsChannel,
    intenticOsFactsFrom,
    IntenticOsReleaseSchema,
    IntenticOsStatusSchema,
    IntenticOsUpdateCheckSchema,
    isIntenticOs,
} from "./intentic-os.js";

// What `ic os` answers, as examples: golden/intentic-os.json holds a release.json, the shapes `ic os status --json`
// gives (a quiet box, one with an update staged and a failed boot, one whose bootc said little) and both answers of
// `ic os update --check --json`. This is the TS half: what ic gives is what the contract reads, to the field.

// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const GOLDEN = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "intentic-os.json"), "utf8")) as {
    readonly release: unknown;
    readonly status: readonly Readonly<Record<string, unknown>>[];
    readonly updateCheck: readonly Readonly<Record<string, unknown>>[];
    readonly [settings: string]: unknown;
};

test("every status and update check in the golden reads back field for field", () => {
    expect(GOLDEN.status.length).toBe(3);
    for (const status of GOLDEN.status) {
        const read: unknown = IntenticOsStatusSchema.parse(status);
        expect(read).toEqual(status);
    }
    for (const check of GOLDEN.updateCheck) {
        const read: unknown = IntenticOsUpdateCheckSchema.parse(check);
        expect(read).toEqual(check);
    }
});

test("a status from a newer ic keeps what this side reads, and only a wrong verdict, isolation or OS is no status", () => {
    const [quiet] = GOLDEN.status;
    const read: unknown = IntenticOsStatusSchema.parse({ ...quiet, pinned: true });
    expect(read).toEqual(quiet);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, health: { verdict: "amber", failed: [] } }).success).toBe(false);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, isolation: "gvisor" }).success).toBe(false);
    expect(IntenticOsStatusSchema.safeParse({ ...quiet, os: "fedora" }).success).toBe(false);
});

test("the facts a device reports are release.json's edition, version and channel, under the OS's own name", () => {
    const release = IntenticOsReleaseSchema.parse(GOLDEN.release);
    const facts = intenticOsFactsFrom(release);
    expect(facts).toEqual({ name: "intentic-os", edition: "server", version: "2026.10.13.0", channel: "stable" });
    expect(isIntenticOs({ intenticOs: facts })).toBe(true);
    expect(isIntenticOs({})).toBe(false);
    expect(isIntenticOs(undefined)).toBe(false);
    expect(isIntenticOs({ intenticOs: { name: "Intentic OS" } })).toBe(false);
    // An optional fact: a device on any other OS says nothing, and an older daemon's read of a newer one is unharmed.
    const device = { os: "Intentic OS 2026.10.13.0 (kernel 6.11)", arch: "x64", shell: "/bin/bash", home: "/var/home/intentic", roots: [] };
    expect(DeviceFactsSchema.parse({ ...device, intenticOs: facts }).intenticOs).toEqual(facts);
    expect(DeviceFactsSchema.parse(device).intenticOs).toBeUndefined();
});

test("a release.json without its edition, version or channel is not one", () => {
    expect(IntenticOsReleaseSchema.safeParse({ name: "Intentic OS", edition: "server", version: "2026.10.13.0" }).success).toBe(false);
});

test("the argv is ic's own verbs, the one spelling every caller uses", () => {
    expect(icOsStatusArgs()).toEqual(["os", "status", "--json"]);
    expect(icOsUpdateArgs("check")).toEqual(["os", "update", "--check", "--json"]);
    expect(icOsUpdateArgs("stage")).toEqual(["os", "update"]);
    expect(icOsUpdateArgs("apply")).toEqual(["os", "update", "--apply"]);
    expect(icOsRollbackArgs(false)).toEqual(["os", "rollback"]);
    expect(icOsRollbackArgs(true)).toEqual(["os", "rollback", "--apply"]);
    expect(icOsRebootArgs()).toEqual(["os", "reboot"]);
    expect(icOsChannelArgs("beta")).toEqual(["os", "channel", "beta"]);
    expect(icOsChannelArgs("stable")).toEqual(["os", "channel", "stable"]);
});

test("a channel ic does not have never reaches it, even past the type", () => {
    for (const channel of ["--apply", "nightly"]) {
        // SAFETY: deliberately not a channel: what a caller that skipped its own schema would pass.
        expect(() => icOsChannelArgs(channel as IntenticOsChannel), channel).toThrow();
    }
});

/* THE MACHINE'S SETTINGS: the network, sound, screens, keyboard and drives, as ic's settings verbs print them. */

test("every settings answer in the golden reads back field for field", () => {
    const readers = {
        networkStatus: IntenticOsNetworkStatusSchema,
        wifiList: IntenticOsWifiListSchema,
        soundStatus: IntenticOsSoundStatusSchema,
        soundOutputs: IntenticOsSoundOutputsSchema,
        displayList: IntenticOsDisplayListSchema,
        keyboardStatus: IntenticOsKeyboardStatusSchema,
        keyboardLayouts: IntenticOsKeyboardLayoutsSchema,
        drives: IntenticOsDrivesSchema,
        driveImportProgress: IntenticOsDriveImportProgressSchema,
        driveImport: IntenticOsDriveImportSchema,
    } as const;
    for (const [key, schema] of Object.entries(readers)) {
        const examples = GOLDEN[key];
        expect(Array.isArray(examples), key).toBe(true);
        // SAFETY: checked to be an array just above.
        for (const example of examples as unknown[]) {
            const read: unknown = schema.parse(example);
            expect(read, key).toEqual(example);
        }
    }
});

test("the status bar's two shapes are exactly what it reads, and nothing looser", () => {
    expect(IntenticOsNetworkStatusSchema.safeParse({ connected: true, kind: "wifi", name: "x", signal: 101 }).success).toBe(false);
    expect(IntenticOsNetworkStatusSchema.safeParse({ connected: true, kind: "cellular", name: "x", signal: null }).success).toBe(false);
    expect(IntenticOsSoundStatusSchema.safeParse({ volume: -1, muted: false, output: null }).success).toBe(false);
    expect(IntenticOsSoundStatusSchema.safeParse({ volume: 40.5, muted: false, output: null }).success).toBe(false);
});

test("the exit codes a caller tells apart are distinct", () => {
    const codes = [IC_OS_NOT_INTENTIC_OS_EXIT, IC_OS_NO_SCREEN_EXIT, IC_OS_WIFI_PASSWORD_EXIT, IC_OS_DRIVE_NO_ROOM_EXIT];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(0);
    expect(codes).not.toContain(1);
});

test("the settings argv is ic's own verbs, and a password never rides on it", () => {
    expect(icOsNetworkStatusArgs()).toEqual(["os", "network", "status", "--json"]);
    expect(icOsWifiListArgs()).toEqual(["os", "network", "wifi", "list", "--json"]);
    expect(icOsWifiConnectArgs("Home Fiber", false)).toEqual(["os", "network", "wifi", "connect", "--", "Home Fiber"]);
    expect(icOsWifiConnectArgs("-guest", true)).toEqual(["os", "network", "wifi", "connect", "--password-stdin", "--", "-guest"]);
    expect(icOsWifiForgetArgs("Office")).toEqual(["os", "network", "wifi", "forget", "--", "Office"]);
    expect(icOsWifiRadioArgs(false)).toEqual(["os", "network", "wifi", "off"]);
    expect(icOsWifiRadioArgs(true)).toEqual(["os", "network", "wifi", "on"]);
    expect(icOsSoundStatusArgs()).toEqual(["os", "sound", "status", "--json"]);
    expect(icOsSoundSetArgs({ volume: 40 })).toEqual(["os", "sound", "set", "--volume", "40", "--json"]);
    expect(icOsSoundSetArgs({ volume: 39.6, muted: false })).toEqual(["os", "sound", "set", "--volume", "40", "--unmute", "--json"]);
    expect(icOsSoundSetArgs({ muted: true })).toEqual(["os", "sound", "set", "--mute", "--json"]);
    expect(icOsSoundOutputsArgs()).toEqual(["os", "sound", "outputs", "--json"]);
    expect(icOsSoundOutputArgs(58)).toEqual(["os", "sound", "output", "58"]);
    expect(icOsDisplayListArgs()).toEqual(["os", "display", "list", "--json"]);
    expect(icOsDisplaySetArgs("DP-2", { mode: { width: 1920, height: 1080, refresh: 59.94 } })).toEqual([
        "os",
        "display",
        "set",
        "DP-2",
        "--mode",
        "1920x1080@59.94",
    ]);
    expect(icOsDisplaySetArgs("eDP-1", { scale: 1.25 })).toEqual(["os", "display", "set", "eDP-1", "--scale", "1.25"]);
    expect(displayModeArg({ width: 2256, height: 1504, refresh: 59.9994 })).toBe("2256x1504@59.999");
    expect(displayModeArg({ width: 3840, height: 2160, refresh: 60 })).toBe("3840x2160@60");
    expect(icOsKeyboardStatusArgs()).toEqual(["os", "keyboard", "status", "--json"]);
    expect(icOsKeyboardLayoutsArgs()).toEqual(["os", "keyboard", "layouts", "--json"]);
    expect(icOsKeyboardSetArgs("de", "nodeadkeys")).toEqual(["os", "keyboard", "set", "de", "--variant", "nodeadkeys"]);
    expect(icOsKeyboardSetArgs("us")).toEqual(["os", "keyboard", "set", "us"]);
    expect(icOsDrivesListArgs()).toEqual(["os", "drives", "list", "--json"]);
    expect(icOsDriveImportArgs("/dev/sda1", "work")).toEqual(["os", "drives", "import", "/dev/sda1", "--to", "work", "--json"]);
    expect(icOsDriveImportArgs("/dev/sda1", "work", "Photos/2026")).toEqual([
        "os",
        "drives",
        "import",
        "/dev/sda1",
        "--to",
        "work",
        "--path",
        "Photos/2026",
        "--json",
    ]);
    expect(icOsDriveEjectArgs("/dev/sdb1")).toEqual(["os", "drives", "eject", "/dev/sdb1"]);
});

test("a value that would reach ic as a flag, a path out, or nothing to change never does", () => {
    const refused: (() => readonly string[])[] = [
        () => icOsWifiConnectArgs("", false),
        () => icOsWifiConnectArgs("x".repeat(33), false),
        // 11 two-byte letters is 22 characters' worth of bytes past 32, though only 17 characters.
        () => icOsWifiForgetArgs("ü".repeat(17)),
        () => icOsSoundSetArgs({}),
        () => icOsSoundSetArgs({ volume: 101 }),
        () => icOsSoundOutputArgs(-1),
        () => icOsDisplaySetArgs("--all", { scale: 1 }),
        () => icOsDisplaySetArgs("DP-2", {}),
        () => icOsDisplaySetArgs("DP-2", { scale: 9 }),
        () => icOsKeyboardSetArgs("-de"),
        () => icOsKeyboardSetArgs("de", "x y"),
        () => icOsDriveImportArgs("/etc/passwd", "work"),
        () => icOsDriveImportArgs("/dev/../etc", "work"),
        () => icOsDriveImportArgs("/dev/sda1", "--rm"),
        () => icOsDriveImportArgs("/dev/sda1", "a..b"),
        () => icOsDriveImportArgs("/dev/sda1", "work", "../history"),
        () => icOsDriveImportArgs("/dev/sda1", "work", "/etc"),
        () => icOsDriveImportArgs("/dev/sda1", "work", "a//b"),
        () => icOsDriveEjectArgs("sda"),
    ];
    for (const [index, call] of refused.entries()) {
        expect(call, String(index)).toThrow();
    }
    expect(icOsWifiForgetArgs("ü".repeat(16))).toHaveLength(6);
});
