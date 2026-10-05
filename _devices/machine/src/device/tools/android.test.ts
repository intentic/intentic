import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { fakeAdb, fakeIndicatorDeps, phonePng, SETTINGS_DUMP, uiDump, uiNode } from "../device-testing.js";
import { createIndicator } from "../indicator.js";
import { ScopeError } from "../policy.js";
import { adbMissing, NO_DEVICE } from "./android-parse.js";
import { type AdbOutput, createAndroid, scrollSwipe } from "./android.js";

/* The Android tools driven against a fake adb that answers by argv, so every rule is checked without a phone: which
   switch each needs, which phone a call lands on, how a coordinate becomes a phone pixel, and what is refused before
   anything is sent. */

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

const SERIAL = "R58M12ABCDE";
const ONE_PHONE = `List of devices attached\n${SERIAL}            device usb:1-1 product:o1sxxx model:SM_G991B device:o1s transport_id:1\n`;
const TWO_PHONES = `${ONE_PHONE}192.168.1.20:37005     unauthorized transport_id:3\n`;

interface Harness {
    readonly android: ReturnType<typeof createAndroid>;
    readonly calls: string[];
    // The grey the phone's screen is; change it and the next screenshot differs.
    shade: number;
    devices: string;
}

const harness = (
    options: { readonly respond?: (args: readonly string[], phone: Harness) => Partial<AdbOutput> | undefined; readonly paused?: boolean } = {},
): Harness => {
    // The harness the fake answers from, set once just below: the fake has to exist before the harness can hold it.
    const holder = new Map<"phone", Harness>();
    const adb = fakeAdb((args) => {
        const state = holder.get("phone");
        if (state === undefined) {
            throw new Error("the fake adb answered before its harness was made");
        }
        const answer = options.respond?.(args, state);
        if (answer !== undefined) {
            return answer;
        }
        const joined = args.join(" ");
        if (joined === "devices -l") {
            return { stdout: Buffer.from(state.devices) };
        }
        if (joined.endsWith("exec-out screencap -p")) {
            return { stdout: phonePng(1080, 2400, state.shade) };
        }
        if (joined.endsWith("exec-out uiautomator dump /dev/tty")) {
            return { stdout: Buffer.from(SETTINGS_DUMP) };
        }
        if (joined.endsWith("shell wm size")) {
            return { stdout: Buffer.from("Physical size: 1080x2400\n") };
        }
        return undefined;
    });
    const indicator = createIndicator(fakeIndicatorDeps({ paused: options.paused ?? false }).deps);
    const phone: Harness = {
        android: createAndroid({ adb: () => adb.run, platform: "linux", indicator: () => indicator, settle: async () => {} }),
        calls: adb.calls,
        shade: 40,
        devices: ONE_PHONE,
    };
    holder.set("phone", phone);
    return phone;
};

// What was sent to the phone itself: every call but the device listing.
const sent = (phone: Harness): string[] => phone.calls.filter((call) => call !== "devices -l");

// Each block of a tool's answer as text, an image as "<image>".
const texts = (result: Record<string, unknown>): string[] => {
    const content = result["content"];
    if (!Array.isArray(content)) {
        throw new TypeError("a tool answer without content");
    }
    return content.map((block: { type: string; text?: string }) => (block.type === "image" ? "<image>" : (block.text ?? "")));
};

const frameIdOf = (result: Record<string, unknown>): string => /Phone screenshot (phone-\S+?):/.exec(texts(result).join("\n"))?.[1] ?? "";

test("every tool asks for its switch before adb is even looked for", async () => {
    let looked = 0;
    const android = createAndroid({
        adb: () => {
            looked += 1;
            return undefined;
        },
        platform: "linux",
        indicator: () => createIndicator(fakeIndicatorDeps().deps),
        settle: async () => {},
    });
    await expect(android.devices(scopes({ shell: "off" }))).rejects.toThrow(/"Run commands" is switched off/);
    await expect(android.screenshot(undefined, scopes({ screen: "off" }))).rejects.toThrow(/"See the screen" is switched off/);
    await expect(android.uiElements({}, scopes({ screen: "off" }))).rejects.toThrow(ScopeError);
    await expect(android.act({ action: "home" }, scopes({ control: "off" }))).rejects.toThrow(/"Use the mouse and keyboard" is switched off/);
    await expect(android.shell({ command: "ls" }, scopes({ shell: "off" }))).rejects.toThrow(ScopeError);
    await expect(android.install({ path: "/tmp/app.apk" }, scopes({ write: "off" }))).rejects.toThrow(/"Create and change files" is switched off/);
    await expect(android.logcat({}, scopes({ shell: "off" }))).rejects.toThrow(ScopeError);
    expect(looked).toBe(0);
    // Past the switch, a computer with no adb is told how to get it.
    await expect(android.devices(scopes())).rejects.toThrow(adbMissing("linux"));
    await expect(android.act({ action: "home" }, scopes())).rejects.toThrow(adbMissing("linux"));
});

test("android_devices lists each phone with its Android version and screen, and what to do about one not ready", async () => {
    const phone = harness({
        respond: (args) =>
            args.join(" ").endsWith("getprop ro.build.version.release; getprop ro.build.version.sdk; wm size")
                ? { stdout: Buffer.from("14\n34\nPhysical size: 1080x2400\n") }
                : undefined,
    });
    phone.devices = TWO_PHONES;
    const listed = await phone.android.devices(scopes());
    const [head = "", ...json] = listed.split("\n");
    expect(head).toBe("2 Android devices are attached to this computer: pass `serial` to the other android_* tools to say which one.");
    expect(JSON.parse(json.join("\n"))).toEqual([
        {
            serial: SERIAL,
            state: "device",
            model: "SM G991B",
            product: "o1sxxx",
            transport: "usb",
            ready: true,
            androidVersion: "14",
            sdk: 34,
            screen: "1080×2400",
        },
        {
            serial: "192.168.1.20:37005",
            state: "unauthorized",
            transport: "wireless",
            ready: false,
            note: expect.stringContaining('accept the "Allow USB debugging?" prompt on the phone'),
        },
    ]);
    // Nothing attached is an answer, not a failure.
    phone.devices = "List of devices attached\n\n";
    expect(await phone.android.devices(scopes())).toBe(NO_DEVICE);
});

test("a call lands on the only phone, and is refused when there is none or several and none is named", async () => {
    const phone = harness();
    phone.devices = "List of devices attached\n";
    await expect(phone.android.screenshot(undefined, scopes())).rejects.toThrow(NO_DEVICE);
    phone.devices = TWO_PHONES;
    await expect(phone.android.act({ action: "home" }, scopes())).rejects.toThrow(/2 Android devices are attached .*pass `serial`/);
    await expect(phone.android.act({ action: "home", serial: "192.168.1.20:37005" }, scopes())).rejects.toThrow(/not ready \(unauthorized\)/);
    await phone.android.act({ action: "home", serial: SERIAL }, scopes({ screen: "off" }));
    expect(sent(phone)).toEqual([`-s ${SERIAL} shell input keyevent KEYCODE_HOME`]);
});

test("a phone screenshot is a frame of its own: coordinates are read in it and mapped to the phone's pixels", async () => {
    const phone = harness();
    await expect(phone.android.act({ action: "tap", coordinate: [10, 10] }, scopes())).rejects.toThrow(
        /There is no screenshot of R58M12ABCDE \(SM G991B\) yet: take android_screenshot/,
    );
    const shot = await phone.android.screenshot(undefined, scopes());
    const id = frameIdOf(shot);
    expect(texts(shot)).toEqual([
        expect.stringMatching(
            new RegExp(
                `^Phone screenshot ${id}: 655×1456, the whole screen of R58M12ABCDE \\(SM G991B\\), shown at 1/1\\.65 of its 1080×2400 pixels\\. .*frame "${id}"`,
            ),
        ),
        "<image>",
    ]);
    // The middle of the image is the middle of the phone.
    const tapped = await phone.android.act({ action: "tap", coordinate: [327, 728], frame: id }, scopes());
    expect(sent(phone).at(-2)).toBe(`-s ${SERIAL} shell input tap 540 1200`);
    // Nothing changed on the fake's screen, so the confirming look is a sentence, and the frame still stands.
    expect(texts(tapped)).toEqual([
        `Tapped (327, 728). The phone's screen did not change: phone screenshot ${id} is still exactly what it shows, so its coordinates still hold. If something should have happened, it did not.`,
    ]);
    // A desktop screenshot's id is another screen.
    await expect(phone.android.act({ action: "tap", coordinate: [1, 1], frame: "a1b2-3" }, scopes())).rejects.toThrow(
        /"a1b2-3" is not a phone screenshot: .*never in a screenshot of this computer's desktop/,
    );
    // Off the image is refused, not clamped.
    await expect(phone.android.act({ action: "tap", coordinate: [700, 10], frame: id }, scopes())).rejects.toThrow(/outside screenshot/);
    phone.shade = 90;
    const newer = frameIdOf(await phone.android.screenshot(undefined, scopes()));
    expect(newer).not.toBe(id);
    await expect(phone.android.act({ action: "tap", coordinate: [1, 1], frame: id }, scopes())).rejects.toThrow(
        new RegExp(`Phone screenshot ${id} is out of date, or of another phone: the newest of R58M12ABCDE \\(SM G991B\\) is ${newer}`),
    );
});

test("an action that changed the screen answers with the new screenshot", async () => {
    const phone = harness({
        respond: (args, state) => {
            if (args.join(" ").includes("input keyevent KEYCODE_BACK")) {
                state.shade = 200;
            }
            return undefined;
        },
    });
    await phone.android.screenshot(undefined, scopes());
    const result = await phone.android.act({ action: "back" }, scopes());
    expect(texts(result)).toEqual(["Pressed Back.", expect.stringMatching(/^Phone screenshot phone-/), "<image>"]);
    // Driven but not watched: no screenshot, and no capture either.
    const before = phone.calls.length;
    expect(texts(await phone.android.act({ action: "recents" }, scopes({ screen: "off" })))).toEqual([
        'Opened the recent apps. (No screenshot: "See the screen" is off for this device.)',
    ]);
    expect(phone.calls.slice(before)).toEqual(["devices -l", `-s ${SERIAL} shell input keyevent KEYCODE_APP_SWITCH`]);
});

test("the screen's elements are listed with refs, placed in screenshot pixels, and a ref is tapped at its centre", async () => {
    const phone = harness();
    const listing = await phone.android.uiElements({}, scopes());
    expect(listing.split("\n")).toEqual([
        "R58M12ABCDE (SM G991B): 6 elements on screen (com.example.app).",
        "Positions are pixels in a phone screenshot of this screen (655×1456). Pass a ref as `element` to android_act to tap it where it is; refs hold until the next listing, so list again after the screen changes.",
        "e1 RecyclerView id=recycler_view at 328,789 [focusable scrollable]",
        'e2 LinearLayout contains "Network & internet · Wi‑Fi, \\"mobile\\"" at 328,182 [clickable]',
        "e3 Switch id=switch_widget at 588,279 [clickable checked]",
        "e4 ImageButton id=fab at 582,1323 [clickable]",
        "e5 EditText id=search at 328,346 [clickable focusable focused]",
        'e6 TextView "Version 1.0" at 133,443',
    ]);
    await phone.android.act({ action: "tap", element: "e3" }, scopes({ screen: "off" }));
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell input tap 970 460`);
    await phone.android.act({ action: "long_press", element: "e2" }, scopes({ screen: "off" }));
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell input swipe 540 300 540 300 800`);
    await expect(phone.android.act({ action: "tap", element: "e99" }, scopes())).rejects.toThrow(/"e99" is not in the latest list .* \(e1 to e6\)/);
    // Once a screenshot is taken, positions name it.
    const id = frameIdOf(await phone.android.screenshot(undefined, scopes()));
    expect((await phone.android.uiElements({ query: "version" }, scopes())).split("\n").slice(0, 3)).toEqual([
        'R58M12ABCDE (SM G991B): 1 element matching "version" (com.example.app).',
        expect.stringContaining(`Positions are pixels in phone screenshot ${id}.`),
        'e1 TextView "Version 1.0" at 133,443',
    ]);
});

test("a dump the phone cannot send to the terminal is read through a file it then removes", async () => {
    const phone = harness({
        respond: (args) => {
            const joined = args.join(" ");
            if (joined.endsWith("uiautomator dump /dev/tty")) {
                return { stdout: Buffer.from("ERROR: dump to /dev/tty unsupported\n") };
            }
            if (joined.endsWith("exec-out cat /sdcard/window_dump.xml")) {
                return {
                    stdout: Buffer.from(
                        uiDump(1, uiNode({ class: "android.widget.Button", text: "OK", clickable: "true", bounds: "[100,100][300,200]" })),
                    ),
                };
            }
            return undefined;
        },
    });
    expect(await phone.android.uiElements({}, scopes())).toContain('e1 Button "OK"');
    expect(sent(phone)).toEqual([
        `-s ${SERIAL} exec-out uiautomator dump /dev/tty`,
        `-s ${SERIAL} shell uiautomator dump /sdcard/window_dump.xml`,
        `-s ${SERIAL} exec-out cat /sdcard/window_dump.xml`,
        `-s ${SERIAL} shell rm -f /sdcard/window_dump.xml`,
        `-s ${SERIAL} shell wm size`,
    ]);
    const stuck = harness({
        respond: (args) => (args.join(" ").includes("uiautomator") ? { stdout: Buffer.from("ERROR: could not get idle state.\n") } : undefined),
    });
    await expect(stuck.android.uiElements({}, scopes())).rejects.toThrow(
        /could not get idle state\.\)\. A screen that never stops moving .*android_screenshot/,
    );
});

test("typed text is sent so the phone types exactly it, and what it cannot type or must not is refused before anything is sent", async () => {
    const phone = harness();
    await phone.android.act({ action: "type", text: "it's 50% done\n" }, scopes({ screen: "off" }));
    expect(sent(phone)).toEqual([`-s ${SERIAL} shell input text 'it'\\''s%s50%%sdone' && input keyevent 66`]);
    const before = phone.calls.length;
    await expect(phone.android.act({ action: "type", text: "rm -rf ~\n" }, scopes({ destructive: "off" }))).rejects.toThrow(
        /Typing a command is running it, so the same switch decides/,
    );
    await expect(phone.android.act({ action: "type", text: "naïve" }, scopes())).rejects.toThrow(/plain ASCII only/);
    await expect(phone.android.act({ action: "key", text: "POWER" }, scopes())).rejects.toThrow(
        /^Refused: KEYCODE_POWER turns the phone's screen off/,
    );
    await expect(phone.android.act({ action: "key" }, scopes())).rejects.toThrow(/"text" is required to press a key/);
    expect(phone.calls.length).toBe(before);
    await phone.android.act({ action: "key", text: "Return" }, scopes({ screen: "off" }));
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell input keyevent KEYCODE_ENTER`);
});

test("input is refused while the person at the computer has paused the agent", async () => {
    const phone = harness({ paused: true });
    await expect(phone.android.act({ action: "home" }, scopes())).rejects.toThrow(/paused by the person at this computer/);
    expect(sent(phone)).toEqual([]);
});

test("a scroll drags the content the other way, in the screen's middle band; a swipe goes where it is told", async () => {
    expect(scrollSwipe({ x: 540, y: 1200 }, { width: 1080, height: 2400 }, "down")).toEqual([
        { x: 540, y: 1740 },
        { x: 540, y: 660 },
    ]);
    // Near the bottom edge it moves up into the band instead of starting on the navigation bar.
    expect(scrollSwipe({ x: 540, y: 2350 }, { width: 1080, height: 2400 }, "up")).toEqual([
        { x: 540, y: 1080 },
        { x: 540, y: 2160 },
    ]);
    expect(scrollSwipe({ x: 540, y: 1200 }, { width: 1080, height: 2400 }, "right")).toEqual([
        { x: 783, y: 1200 },
        { x: 297, y: 1200 },
    ]);
    const phone = harness();
    const id = frameIdOf(await phone.android.screenshot(undefined, scopes()));
    await phone.android.act({ action: "scroll", amount: 2 }, scopes({ screen: "off" }));
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell input swipe 540 1740 540 660 400 && input swipe 540 1740 540 660 400`);
    await phone.android.act({ action: "swipe", coordinate: [100, 1000], to: [100, 200], frame: id }, scopes({ screen: "off" }));
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell input swipe 165 1649 165 330 300`);
    await expect(phone.android.act({ action: "swipe", coordinate: [100, 1000] }, scopes())).rejects.toThrow(/swipe needs `to`/);
    await expect(phone.android.act({ action: "tap" }, scopes())).rejects.toThrow(/tap needs `element`/);
});

test("android_shell runs on the phone, and refuses what would lose something unless the destructive switch is on", async () => {
    const phone = harness({
        respond: (args) => {
            const command = args.at(-1) ?? "";
            if (command === "dumpsys battery") {
                return { stdout: Buffer.from("Current Battery Service state:\n  level: 81\n") };
            }
            if (command === "ls /nope") {
                return { code: 1, stderr: "ls: /nope: No such file or directory\n" };
            }
            if (command === "sleep 999") {
                return { code: null, timedOut: true };
            }
            return undefined;
        },
    });
    expect(await phone.android.shell({ command: "dumpsys battery" }, scopes())).toBe(
        "On R58M12ABCDE (SM G991B): Exit code 0 (success).\n--- stdout ---\nCurrent Battery Service state:\n  level: 81",
    );
    expect(await phone.android.shell({ command: "ls /nope" }, scopes())).toContain(
        "Exit code 1 (failed).\n--- stderr ---\nls: /nope: No such file or directory",
    );
    expect(await phone.android.shell({ command: "sleep 999", timeoutMs: 5_000 }, scopes())).toContain("The command was stopped after 5s");
    const before = phone.calls.length;
    await expect(phone.android.shell({ command: "pm uninstall com.example.app" }, scopes({ destructive: "off" }))).rejects.toThrow(
        'Refused: on the phone this command would uninstall an app, and "Run destructive commands" is switched off for this device.',
    );
    // The shared classifier and the phone's own list name a recursive delete once.
    await expect(phone.android.shell({ command: "rm -rf /sdcard/Download/old" }, scopes({ destructive: "off" }))).rejects.toThrow(
        /would delete files recursively, and "Run destructive commands"/,
    );
    await expect(phone.android.shell({ command: "settings put system screen_off_timeout 10" }, scopes({ destructive: "off" }))).rejects.toThrow(
        ScopeError,
    );
    await expect(phone.android.shell({ command: "input keyevent 26" }, scopes())).rejects.toThrow(/^Refused: input keyevent 26 \(KEYCODE_POWER\)/);
    expect(phone.calls.length).toBe(before);
    await phone.android.shell({ command: "pm uninstall com.example.app" }, scopes());
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} shell pm uninstall com.example.app`);
});

test("android_install takes an APK inside the allowed folders and says what the phone answered", async () => {
    const root = mkdtempSync(join(tmpdir(), "android-install-"));
    const apk = join(root, "app-debug.apk");
    writeFileSync(apk, "PK");
    writeFileSync(join(root, "notes.txt"), "x");
    try {
        const phone = harness({
            respond: (args) =>
                args.includes("install")
                    ? args.at(-1)?.endsWith("app-debug.apk") === true && phone.shade === 40
                        ? { stdout: Buffer.from("Performing Streamed Install\nSuccess\n") }
                        : {
                              code: 1,
                              stderr: "adb: failed to install app-debug.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]\n",
                          }
                    : undefined,
        });
        const grant = scopes({ roots: root });
        expect(await phone.android.install({ path: apk }, grant)).toBe(
            `Installed ${apk} on R58M12ABCDE (SM G991B), replacing the app's earlier version if it had one (its data is kept).`,
        );
        expect(sent(phone).at(-1)).toMatch(new RegExp(`^-s ${SERIAL} install -r .*app-debug\\.apk$`));
        phone.shade = 41;
        await expect(phone.android.install({ path: apk }, grant)).rejects.toThrow(/did not install .*INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
        await expect(phone.android.install({ path: join(root, "notes.txt") }, grant)).rejects.toThrow(/is not an \.apk/);
        await expect(phone.android.install({ path: join(root, "missing.apk") }, grant)).rejects.toThrow(/There is no file/);
        await expect(phone.android.install({ path: "/etc/app.apk" }, grant)).rejects.toThrow(/outside the folders this device allows/);
        await expect(phone.android.install({ path: apk }, scopes({ roots: root, shell: "off" }))).rejects.toThrow(/"Run commands" is switched off/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("android_logcat reads the tail of the log, narrowed to an app's process, a tag or a priority", async () => {
    const phone = harness({
        respond: (args) => {
            const joined = args.join(" ");
            if (joined.endsWith("shell pidof com.example.app")) {
                return { stdout: Buffer.from("4321\n") };
            }
            if (joined.endsWith("shell pidof com.example.gone")) {
                return { code: 1 };
            }
            if (args.includes("logcat")) {
                return { stdout: Buffer.from("10-05 12:00:00.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main\r\n") };
            }
            return undefined;
        },
    });
    expect(await phone.android.logcat({ package: "com.example.app" }, scopes())).toBe(
        "Up to the last 200 lines of R58M12ABCDE (SM G991B)'s log from com.example.app (pid 4321):\n10-05 12:00:00.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main",
    );
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} logcat -d -t 200 --pid=4321`);
    await phone.android.logcat({ tag: "AndroidRuntime", priority: "E", lines: 50 }, scopes());
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} logcat -d -t 50 AndroidRuntime:E *:S`);
    await phone.android.logcat({ priority: "W" }, scopes());
    expect(sent(phone).at(-1)).toBe(`-s ${SERIAL} logcat -d -t 200 *:W`);
    await expect(phone.android.logcat({ package: "com.example.gone" }, scopes())).rejects.toThrow(/com\.example\.gone is not running on R58M12ABCDE/);
    await expect(phone.android.logcat({ package: "com.x; reboot" }, scopes())).rejects.toThrow(/is not an Android package name/);
    await expect(phone.android.logcat({ tag: "a b" }, scopes())).rejects.toThrow(/is not a log tag/);
});
