import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type {
    IntenticOsDisplayList,
    IntenticOsDriveImport,
    IntenticOsDriveImportProgress,
    IntenticOsDrives,
    IntenticOsKeyboardLayouts,
    IntenticOsKeyboardStatus,
    IntenticOsNetworkStatus,
    IntenticOsSoundOutputs,
    IntenticOsSoundStatus,
    IntenticOsWifiList,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { ScopeError } from "../../policy.js";
import { icInFlight, type IcRun } from "../sandboxes.js";
import type { OsDeps } from "./os.js";
import {
    displayList,
    displaySet,
    driveEject,
    driveImport,
    drivesList,
    keyboardLayouts,
    keyboardSet,
    keyboardStatus,
    layoutsMatching,
    networkStatus,
    osSettingsTools,
    soundOutput,
    soundOutputs,
    soundSet,
    soundStatus,
    wifiConnect,
    wifiForget,
    wifiList,
    wifiRadio,
} from "./settings.js";

// The settings tools are thin callers of `ic os`, like the OS tools (os.test.ts): what they may do is the device's
// switches, what they run is the contract's argv, what they answer is ic's JSON read as the contract's, and ic's own
// exit codes come back in words. ic is a fake here that records what it was asked, and what it was given on stdin.

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "off",
    programs: "off",
    ...overrides,
});

// The contract's example of every answer, the file ic's Rust is held to.
const GOLDEN_PATH = join(repoRoot(import.meta.url), "_shared/sandbox-contract/golden/intentic-os.json");
// SAFETY: the golden is this repository's own file; the assertions below fail on any answer it lacks.
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
    readonly networkStatus: IntenticOsNetworkStatus[];
    readonly wifiList: IntenticOsWifiList[];
    readonly soundStatus: IntenticOsSoundStatus[];
    readonly soundOutputs: IntenticOsSoundOutputs[];
    readonly displayList: IntenticOsDisplayList[];
    readonly keyboardStatus: IntenticOsKeyboardStatus[];
    readonly keyboardLayouts: IntenticOsKeyboardLayouts[];
    readonly drives: IntenticOsDrives[];
    readonly driveImportProgress: IntenticOsDriveImportProgress[];
    readonly driveImport: IntenticOsDriveImport[];
};

interface Asked {
    readonly args: readonly string[];
    readonly deadlineMs: number | undefined;
    readonly input: string | undefined;
}

interface FakeIc {
    readonly deps: OsDeps;
    readonly asked: Asked[];
}

// An ic that answers what `answer` makes of each call and remembers each argv, its deadline and its stdin.
const answering = (answer: (asked: Asked) => IcRun): FakeIc => {
    const asked: Asked[] = [];
    return {
        asked,
        deps: {
            ic: async (args, { deadlineMs, input }) => {
                const call = { args, deadlineMs, input };
                asked.push(call);
                return answer(call);
            },
        },
    };
};

// One that answers `run` to everything.
const fakeIc = (run: IcRun): FakeIc => answering(() => run);

const ok = (output: string): IcRun => ({ code: 0, output });
// One golden answer the way ic prints it: a note on stderr first, then its one line of JSON.
const printed = (answer: object): IcRun => ok(`note: answered slowly\n${JSON.stringify(answer)}\n`);

describe("the reads", () => {
    test("each is ic's own answer, read as the contract's and passed on as JSON, behind a deadline", async () => {
        const reads = [
            { read: networkStatus, answers: GOLDEN.networkStatus, args: ["os", "network", "status", "--json"], deadlineMs: 30_000 },
            // A rescan comes first, so the Wi-Fi list has longer.
            { read: wifiList, answers: GOLDEN.wifiList, args: ["os", "network", "wifi", "list", "--json"], deadlineMs: 60_000 },
            { read: soundStatus, answers: GOLDEN.soundStatus, args: ["os", "sound", "status", "--json"], deadlineMs: 30_000 },
            { read: soundOutputs, answers: GOLDEN.soundOutputs, args: ["os", "sound", "outputs", "--json"], deadlineMs: 30_000 },
            { read: displayList, answers: GOLDEN.displayList, args: ["os", "display", "list", "--json"], deadlineMs: 30_000 },
            { read: keyboardStatus, answers: GOLDEN.keyboardStatus, args: ["os", "keyboard", "status", "--json"], deadlineMs: 30_000 },
            { read: drivesList, answers: GOLDEN.drives, args: ["os", "drives", "list", "--json"], deadlineMs: 30_000 },
        ];
        for (const { read, answers, args, deadlineMs } of reads) {
            for (const answer of answers) {
                const ic = fakeIc(printed(answer));
                expect(JSON.parse(await read(scopes(), ic.deps)), args.join(" ")).toEqual(answer);
                expect(ic.asked).toEqual([{ args, deadlineMs, input: undefined }]);
            }
        }
    });

    test("a key a newer ic adds is dropped, and an answer this agent cannot read says so with what ic printed", async () => {
        const [status] = GOLDEN.soundStatus;
        expect(JSON.parse(await soundStatus(scopes(), fakeIc(printed({ ...status, balance: 0 })).deps))).toEqual(status);
        await expect(soundStatus(scopes(), fakeIc(printed({ ...status, volume: 140 })).deps)).rejects.toThrow(
            /did not answer `ic os sound status --json` in the shape this agent reads/,
        );
        await expect(networkStatus(scopes(), fakeIc(ok("error: unrecognized subcommand 'network'")).deps)).rejects.toThrow(/unrecognized subcommand 'network'/);
    });

    test("are ways of seeing: either switch will do, and neither is refused before ic is asked", async () => {
        const ic = fakeIc(printed(GOLDEN.drives[0] ?? {}));
        await expect(drivesList(scopes({ shell: "off" }), ic.deps)).resolves.toContain("KINGSTON");
        await expect(drivesList(scopes({ sandboxes: "off" }), ic.deps)).resolves.toContain("KINGSTON");
        await expect(drivesList(scopes({ shell: "off", sandboxes: "off" }), ic.deps)).rejects.toThrow(ScopeError);
        await expect(wifiList(scopes({ shell: "off", sandboxes: "off" }), ic.deps)).rejects.toThrow(/Manage sandboxes on this device/);
        expect(ic.asked).toHaveLength(2);
    });

    test("the screen's reads on the server edition say it has no screen, and a machine that is not Intentic OS says that", async () => {
        const noScreen = fakeIc({ code: 4, output: "this edition has no screen" });
        await expect(displayList(scopes(), noScreen.deps)).rejects.toThrow(/has no screen \(it is the server edition\)/);
        await expect(keyboardStatus(scopes(), noScreen.deps)).rejects.toThrow(/has no screen/);
        await expect(keyboardLayouts(undefined, scopes(), noScreen.deps)).rejects.toThrow(/has no screen/);
        await expect(networkStatus(scopes(), fakeIc({ code: 3, output: "not Intentic OS" }).deps)).rejects.toThrow(/not running Intentic OS/);
    });
});

describe("every change", () => {
    const changes: [string, (grant: DeviceScopes, deps: OsDeps) => Promise<string>][] = [
        ["os_wifi_connect", async (grant, deps) => await wifiConnect("Office", "hunter22", grant, deps)],
        ["os_wifi_forget", async (grant, deps) => await wifiForget("Office", grant, deps)],
        ["os_wifi_radio", async (grant, deps) => await wifiRadio(false, grant, deps)],
        ["os_sound_set", async (grant, deps) => await soundSet({ volume: 20 }, grant, deps)],
        ["os_sound_output", async (grant, deps) => await soundOutput(58, grant, deps)],
        ["os_display_set", async (grant, deps) => await displaySet("DP-2", { scale: 1.5 }, grant, deps)],
        ["os_keyboard_set", async (grant, deps) => await keyboardSet("de", undefined, grant, deps)],
        ["os_drive_import", async (grant, deps) => await driveImport({ device: "/dev/sda1", sandbox: "work" }, grant, deps)],
        ["os_drive_eject", async (grant, deps) => await driveEject("/dev/sda1", grant, deps)],
    ];

    test("needs Manage sandboxes, whatever else is on, and ic is never asked without it", async () => {
        const ic = fakeIc(ok(""));
        for (const [name, change] of changes) {
            await expect(change(scopes({ sandboxes: "off", destructive: "on" }), ic.deps), name).rejects.toThrow(/Manage sandboxes on this device/);
        }
        expect(ic.asked).toEqual([]);
    });

    test("runs the contract's argv: each a short change behind a deadline but the import, which is left to finish", async () => {
        const ic = answering((asked) => (asked.args[1] === "sound" && asked.args[2] === "set" ? printed(GOLDEN.soundStatus[0] ?? {}) : ok("")));
        const imported = fakeIc(printed(GOLDEN.driveImport[0] ?? {}));
        for (const [name, change] of changes) {
            await change(scopes(), name === "os_drive_import" ? imported.deps : ic.deps);
        }
        expect(ic.asked.map(({ args, deadlineMs }) => [args, deadlineMs])).toEqual([
            [["os", "network", "wifi", "connect", "--password-stdin", "--", "Office"], 120_000],
            [["os", "network", "wifi", "forget", "--", "Office"], 60_000],
            [["os", "network", "wifi", "off"], 60_000],
            [["os", "sound", "set", "--volume", "20", "--json"], 60_000],
            [["os", "sound", "output", "58"], 60_000],
            [["os", "display", "set", "DP-2", "--scale", "1.5"], 60_000],
            [["os", "keyboard", "set", "de"], 60_000],
            [["os", "drives", "eject", "/dev/sda1"], 300_000],
        ]);
        expect(imported.asked).toEqual([{ args: ["os", "drives", "import", "/dev/sda1", "--to", "work", "--json"], deadlineMs: undefined, input: undefined }]);
    });

    test("on a machine that is not Intentic OS says that, and nothing else", async () => {
        for (const [name, change] of changes) {
            await expect(change(scopes(), fakeIc({ code: 3, output: "not Intentic OS" }).deps), name).rejects.toThrow(/not running Intentic OS/);
        }
    });
});

describe("os_wifi_connect", () => {
    test("a password reaches ic on stdin and nowhere in its argv; without one, ic is given nothing", async () => {
        const ic = fakeIc(ok("joined Neighbours 5G"));
        expect(await wifiConnect("Neighbours 5G", "correct horse battery", scopes(), ic.deps)).toStartWith("joined Neighbours 5G");
        await wifiConnect("-Home Fiber", undefined, scopes(), ic.deps);
        expect(ic.asked).toEqual([
            { args: ["os", "network", "wifi", "connect", "--password-stdin", "--", "Neighbours 5G"], deadlineMs: 120_000, input: "correct horse battery" },
            // An SSID is whatever a network broadcasts, a leading hyphen too: it goes after `--`.
            { args: ["os", "network", "wifi", "connect", "--", "-Home Fiber"], deadlineMs: 120_000, input: undefined },
        ]);
        expect(ic.asked.flatMap((asked) => asked.args).join(" ")).not.toContain("correct horse");
    });

    test("a network that needs a password says how to get it without the chat", async () => {
        const refused = wifiConnect("Office", undefined, scopes(), fakeIc({ code: 5, output: "error: Office needs a password" }).deps);
        await expect(refused).rejects.toThrow(/"Office" needs a password this machine does not know/);
        await expect(wifiConnect("Office", undefined, scopes(), fakeIc({ code: 5, output: "" }).deps)).rejects.toThrow(
            /Do not ask the owner to paste it into chat.*the Devices page on this machine's own screen/,
        );
    });

    test("a refused password is said as that, and never comes back in the answer, even from an ic that echoes it", async () => {
        const echoed = fakeIc({ code: 5, output: "error: secrets were required: psk hunter22 rejected" });
        const refusal = await wifiConnect("Office", "hunter22", scopes(), echoed.deps).catch(String);
        expect(refusal).toMatch(/"Office" did not accept that password/);
        expect(refusal).toContain("psk <the password> rejected");
        expect(refusal).not.toContain("hunter22");
        const failed = await wifiConnect("Office", "hunter22", scopes(), fakeIc({ code: 1, output: "nmcli: hunter22?" }).deps).catch(String);
        expect(failed).toMatch(/could not join "Office"/);
        expect(failed).not.toContain("hunter22");
        const joined = await wifiConnect("Office", "hunter22", scopes(), fakeIc(ok("joined Office with hunter22")).deps);
        expect(joined).not.toContain("hunter22");
    });
});

describe("the other changes", () => {
    test("the radio and forgetting each say what follows", async () => {
        const ic = fakeIc(ok(""));
        expect(await wifiRadio(false, scopes(), ic.deps)).toContain("turns it back on");
        expect(await wifiRadio(true, scopes(), ic.deps)).toStartWith("Wi-Fi is on.");
        expect(await wifiForget("Office", scopes(), ic.deps)).toContain("joining it again takes its password");
    });

    test("a sound change answers with the sound after it, and one naming nothing is refused before ic", async () => {
        const after = GOLDEN.soundStatus[1];
        const ic = fakeIc(printed(after ?? {}));
        expect(JSON.parse(await soundSet({ volume: 99.6, muted: true }, scopes(), ic.deps))).toEqual(after);
        await expect(soundSet({}, scopes(), ic.deps)).rejects.toThrow(/Nothing was changed: give `volume`, `muted`, or both/);
        expect(ic.asked.map((asked) => asked.args)).toEqual([["os", "sound", "set", "--volume", "100", "--mute", "--json"]]);
    });

    test("a screen change takes a mode as the listing gives it, refuses one naming nothing, and says so on the server edition", async () => {
        const ic = fakeIc(ok(""));
        await displaySet("DP-2", { mode: { width: 2560, height: 1440, refresh: 59.951 }, scale: 1 }, scopes(), ic.deps);
        expect(ic.asked.map((asked) => asked.args)).toEqual([["os", "display", "set", "DP-2", "--mode", "2560x1440@59.951", "--scale", "1"]]);
        await expect(displaySet("DP-2", {}, scopes(), ic.deps)).rejects.toThrow(/Nothing was changed: give `mode`, `scale`, or both/);
        expect(ic.asked).toHaveLength(1);
        await expect(displaySet("eDP-1", { scale: 2 }, scopes(), fakeIc({ code: 4, output: "" }).deps)).rejects.toThrow(/has no screen/);
        await expect(keyboardSet("de", "nodeadkeys", scopes(), fakeIc({ code: 4, output: "" }).deps)).rejects.toThrow(/has no screen/);
    });

    test("a layout with its variant", async () => {
        const ic = fakeIc(ok(""));
        expect(await keyboardSet("de", "nodeadkeys", scopes(), ic.deps)).toStartWith("The keyboard layout is de (nodeadkeys) now.");
        expect(ic.asked.map((asked) => asked.args)).toEqual([["os", "keyboard", "set", "de", "--variant", "nodeadkeys"]]);
    });
});

describe("the keyboard layouts", () => {
    const [{ layouts } = { layouts: [] }] = GOLDEN.keyboardLayouts;

    test("a search names layouts by code or name, with all their variants, or only the variants it names", () => {
        // "de" is in "with dead keys" too: a code typed whole means that code.
        expect(layoutsMatching(layouts, "german").map((layout) => layout.layout)).toEqual(["de"]);
        expect(layoutsMatching(layouts, " DE ")).toEqual(layouts.filter((layout) => layout.layout === "de"));
        expect(layoutsMatching(layouts, "dvorak")).toEqual([{ layout: "us", name: "English (US)", variants: [{ variant: "dvorak", name: "English (Dvorak)" }] }]);
        expect(layoutsMatching(layouts, "klingon")).toEqual([]);
    });

    test("case and accents are set aside", () => {
        const french = [{ layout: "fr", name: "French", variants: [{ variant: "bepo", name: "French (BEPO, ergonomic, Dvorak way)" }] }];
        expect(layoutsMatching(french, "Bépo")).toEqual(french);
        expect(layoutsMatching(french, "ERGONOMIC, dvorak")).toEqual(french);
        expect(layoutsMatching([{ layout: "is", name: "Icelandic", variants: [] }], "ÍCELANDIC")).toHaveLength(1);
    });

    test("a code typed whole is that code alone; part of one is looked for everywhere", () => {
        const two = [
            { layout: "us", name: "English (US)", variants: [] },
            { layout: "ru", name: "Russian", variants: [{ variant: "phonetic", name: "Russian (phonetic)" }] },
        ];
        expect(layoutsMatching(two, "us").map((layout) => layout.layout)).toEqual(["us"]);
        expect(layoutsMatching(two, "uss").map((layout) => layout.layout)).toEqual(["ru"]);
        expect(layoutsMatching(two, "phon")).toEqual(two.slice(1));
    });

    test("the tool filters on this side, says so when nothing matches, and gives every layout without a search", async () => {
        const ic = fakeIc(printed({ layouts }));
        expect(JSON.parse(await keyboardLayouts("polish", scopes(), ic.deps))).toEqual({ layouts: [{ layout: "pl", name: "Polish", variants: [] }] });
        expect(await keyboardLayouts("klingon", scopes(), ic.deps)).toMatch(/^No keyboard layout or variant matches "klingon".*all 3 layouts\.$/);
        expect(JSON.parse(await keyboardLayouts(undefined, scopes(), ic.deps))).toEqual({ layouts });
        expect(JSON.parse(await keyboardLayouts("  ", scopes(), ic.deps))).toEqual({ layouts });
        expect(ic.asked.every((asked) => asked.args.join(" ") === "os keyboard layouts --json" && asked.deadlineMs === 30_000)).toBe(true);
    });
});

describe("os_drive_import", () => {
    const [result = GOLDEN.driveImport[0]] = GOLDEN.driveImport;
    const [progress] = GOLDEN.driveImportProgress;

    test("reads the result past ic's progress lines and says what was copied where", async () => {
        const ic = fakeIc(ok([JSON.stringify(progress), JSON.stringify(progress), JSON.stringify(result)].join("\n")));
        const said = await driveImport({ device: "/dev/sda1", sandbox: "work", path: "Photos/2026" }, scopes(), ic.deps);
        expect(said).toStartWith('Copied 42 files (117.7 MB) from /dev/sda1 into the sandbox "work", at /work/Imports/KINGSTON-2026-10-16.');
        expect(said).toContain("os_drive_eject");
        expect(ic.asked[0]?.args).toEqual(["os", "drives", "import", "/dev/sda1", "--to", "work", "--path", "Photos/2026", "--json"]);
    });

    test("holds the sandbox it copies into in flight for the whole copy, and lets it go however it ends", async () => {
        const during: boolean[] = [];
        const watching = (run: IcRun): FakeIc =>
            answering(() => {
                during.push(icInFlight.has("work"));
                return run;
            });
        await driveImport({ device: "/dev/sda1", sandbox: "work" }, scopes(), watching(printed(result ?? {})).deps);
        expect(icInFlight.has("work")).toBe(false);
        await expect(driveImport({ device: "/dev/sda1", sandbox: "work" }, scopes(), watching({ code: 1, output: "docker: no such container" }).deps)).rejects.toThrow(
            /Nothing more was copied from \/dev\/sda1 into "work"\.\n\ndocker: no such container/,
        );
        expect(during).toEqual([true, true]);
        expect(icInFlight.has("work")).toBe(false);
    });

    test("a drive that would not fit says so in ic's own words, after its progress lines", async () => {
        const full = fakeIc({ code: 6, output: `${JSON.stringify(progress)}\nneeds 7.2 GB, and work has 3.1 GB free` });
        await expect(driveImport({ device: "/dev/sda1", sandbox: "work" }, scopes(), full.deps)).rejects.toThrow(
            /^There is not enough room in the sandbox "work" for what is on \/dev\/sda1, so nothing was copied\. needs 7\.2 GB, and work has 3\.1 GB free$/,
        );
    });
});

describe("the tools", () => {
    // Only whether release.json exists is read, so any file that does stands in for it: the golden, here.
    const tools = osSettingsTools(GOLDEN_PATH, fakeIc(ok("")).deps);
    const byName = new Map(tools.map((entry) => [entry.name, entry]));

    test("are offered on Intentic OS alone, the reads read-only and nothing destructive", () => {
        expect(osSettingsTools(join(GOLDEN_PATH, "missing-release.json"))).toEqual([]);
        expect(tools.map((entry) => [entry.name, entry.annotations.readOnlyHint, entry.annotations.destructiveHint])).toEqual([
            ["os_network_status", true, false],
            ["os_wifi_list", true, false],
            ["os_wifi_connect", false, false],
            ["os_wifi_forget", false, false],
            ["os_wifi_radio", false, false],
            ["os_sound_status", true, false],
            ["os_sound_set", false, false],
            ["os_sound_outputs", true, false],
            ["os_sound_output", false, false],
            ["os_display_list", true, false],
            ["os_display_set", false, false],
            ["os_keyboard_status", true, false],
            ["os_keyboard_layouts", true, false],
            ["os_keyboard_set", false, false],
            ["os_drives_list", true, false],
            ["os_drive_import", false, false],
            ["os_drive_eject", false, false],
        ]);
    });

    test("each says which switch it needs, the reads either, every change Manage sandboxes", () => {
        for (const entry of tools) {
            expect(entry.description, entry.name).toEndWith(
                entry.annotations.readOnlyHint
                    ? "Requires 'Run commands' or 'Manage sandboxes on this device'."
                    : "Requires the 'Manage sandboxes on this device' permission.",
            );
        }
        // The two that can take this machine off its network say whose link goes with it.
        for (const name of ["os_wifi_forget", "os_wifi_radio"]) {
            expect(byName.get(name)?.description, name).toMatch(/your own model included/);
        }
    });

    test("a call is held to its schema before ic is asked, and a password's refusal never quotes it", async () => {
        const ic = fakeIc(ok(""));
        const held = osSettingsTools(GOLDEN_PATH, ic.deps);
        const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> =>
            await held.find((entry) => entry.name === name)?.call(args, scopes());
        const twoLines = await call("os_wifi_connect", { ssid: "Office", password: "hunter22\nreboot" });
        expect(twoLines).toMatchObject({ isError: true });
        expect(JSON.stringify(twoLines)).toContain("a Wi-Fi password is one line");
        expect(JSON.stringify(twoLines)).not.toContain("hunter22");
        expect(await call("os_drive_import", { device: "/dev/../etc/shadow", sandbox: "work" })).toMatchObject({ isError: true });
        expect(await call("os_drive_import", { device: "/dev/sda1", sandbox: "work", path: "../escape" })).toMatchObject({ isError: true });
        expect(await call("os_keyboard_set", { layout: "--help" })).toMatchObject({ isError: true });
        expect(await call("os_sound_set", { volume: 140 })).toMatchObject({ isError: true });
        expect(await call("os_display_set", { output: "DP-2", scale: 9 })).toMatchObject({ isError: true });
        expect(ic.asked).toEqual([]);
        await call("os_wifi_connect", { ssid: "Office", password: "hunter22" });
        expect(ic.asked).toEqual([{ args: ["os", "network", "wifi", "connect", "--password-stdin", "--", "Office"], deadlineMs: 120_000, input: "hunter22" }]);
    });
});
