import {
    adbCandidates,
    adbMissing,
    AndroidError,
    androidDestructive,
    assertNoLockoutCommand,
    chooseDevice,
    describeElement,
    findAdb,
    inputTextCommand,
    keyEventFor,
    NO_DEVICE,
    parseAdbDevices,
    parseUiDump,
    parseWmSize,
    phoneElements,
    rotated,
} from "./android-parse.js";
import { SETTINGS_DUMP, uiDump, uiNode } from "../device-testing.js";

/* What adb prints, read without a phone: the device list, the accessibility dump, the size of the screen, and what the
   phone is sent for text and keys. */

test("adb is looked for in the SDK the environment names, then Android Studio's, then on PATH", () => {
    const windows = adbCandidates(
        { ANDROID_HOME: "D:\\sdk", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\tools;C:\\Windows" },
        "win32",
        "C:\\Users\\me",
    );
    expect(windows).toEqual([
        "D:\\sdk\\platform-tools\\adb.exe",
        "C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
        "C:\\tools\\adb.exe",
        "C:\\Windows\\adb.exe",
    ]);
    expect(adbCandidates({ PATH: "/usr/bin:/bin" }, "linux", "/home/me")).toEqual([
        "/home/me/Android/Sdk/platform-tools/adb",
        "/usr/bin/adb",
        "/bin/adb",
    ]);
    expect(findAdb({ PATH: "/usr/bin:/bin" }, "linux", "/home/me", (path) => path === "/bin/adb")).toBe("/bin/adb");
    expect(findAdb({ PATH: "/usr/bin" }, "linux", "/home/me", () => false)).toBeUndefined();
});

test("without adb, the answer is one sentence saying how to get platform-tools on this OS", () => {
    expect(adbMissing("win32")).toMatch(
        /^adb is not installed on this computer.*winget install Google\.PlatformTools.*platform-tools.*ANDROID_HOME, then try again\.$/,
    );
    expect(adbMissing("linux")).toContain("sudo apt install adb");
    expect(adbMissing("linux").split(". ")).toHaveLength(1);
});

const DEVICES = [
    "* daemon not running; starting now at tcp:5037",
    "* daemon started successfully",
    "List of devices attached",
    "R58M12ABCDE            device usb:1-1 product:o1sxxx model:SM_G991B device:o1s transport_id:1",
    "0123456789ABCDEF       unauthorized usb:1-2 transport_id:2",
    "192.168.1.20:37005     device product:panther model:Pixel_7 device:panther transport_id:3",
    "adb-28131FDH2000AB-xYz._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro device:husky transport_id:4",
    "emulator-5554          offline transport_id:5",
    "ZY22ABCD               no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-1 transport_id:6",
    "",
].join("\r\n");

test("`adb devices -l` reads into serial, state, model, product and how each is attached", () => {
    expect(parseAdbDevices(DEVICES)).toEqual([
        { serial: "R58M12ABCDE", state: "device", model: "SM G991B", product: "o1sxxx", transport: "usb" },
        { serial: "0123456789ABCDEF", state: "unauthorized", model: undefined, product: undefined, transport: "usb" },
        { serial: "192.168.1.20:37005", state: "device", model: "Pixel 7", product: "panther", transport: "wireless" },
        { serial: "adb-28131FDH2000AB-xYz._adb-tls-connect._tcp", state: "device", model: "Pixel 8 Pro", product: "husky", transport: "wireless" },
        { serial: "emulator-5554", state: "offline", model: undefined, product: undefined, transport: "emulator" },
        { serial: "ZY22ABCD", state: "no permissions", model: undefined, product: undefined, transport: "usb" },
    ]);
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
});

test("the phone a call is about: the only one, or the one named; several, none, or one not ready is a sentence", () => {
    const [usb, unauthorized, wireless] = parseAdbDevices(DEVICES);
    if (usb === undefined || unauthorized === undefined || wireless === undefined) {
        throw new Error("fixture");
    }
    expect(chooseDevice([usb], undefined)).toBe(usb);
    expect(chooseDevice([usb, wireless], "192.168.1.20:37005")).toBe(wireless);
    expect(() => chooseDevice([], undefined)).toThrow(NO_DEVICE);
    expect(NO_DEVICE).toMatch(/USB debugging.*adb pair <ip>:<pairing port>.*adb connect <ip>:<port>/);
    expect(() => chooseDevice([usb, wireless], undefined)).toThrow(
        "2 Android devices are attached (R58M12ABCDE (SM G991B): ready; 192.168.1.20:37005 (Pixel 7): ready): pass `serial` to say which one.",
    );
    expect(() => chooseDevice([usb], "nope")).toThrow('No Android device "nope" is attached; attached: R58M12ABCDE (SM G991B): ready.');
    expect(() => chooseDevice([unauthorized], undefined)).toThrow(
        /not ready \(unauthorized\): .*accept the "Allow USB debugging\?" prompt on the phone/,
    );
    expect(() => chooseDevice([usb], undefined)).not.toThrow(AndroidError);
});

test("the screen's size is the override where one is set, turned to the rotation the screen is in", () => {
    expect(parseWmSize("Physical size: 1440x3120\nOverride size: 1080x2340\n")).toEqual({ width: 1080, height: 2340 });
    expect(parseWmSize("Physical size: 1080x2400\r\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("")).toBeUndefined();
    expect(rotated({ width: 1080, height: 2400 }, 1)).toEqual({ width: 2400, height: 1080 });
    expect(rotated({ width: 1080, height: 2400 }, 2)).toEqual({ width: 1080, height: 2400 });
});

test("a uiautomator dump reads into nodes with their parents, flags, bounds and unescaped text", () => {
    const { rotation, nodes } = parseUiDump(SETTINGS_DUMP);
    expect(rotation).toBe(0);
    expect(nodes).toHaveLength(10);
    expect(nodes[2]).toMatchObject({ parent: 1, clickable: true, bounds: { x: 0, y: 200, width: 1080, height: 200 } });
    expect(nodes[3]).toMatchObject({ parent: 2, text: "Network & internet", resourceId: "android:id/title" });
    expect(nodes[4]?.text).toBe('Wi\u2011Fi, "mobile"');
    expect(nodes[5]).toMatchObject({ parent: 1, checkable: true, checked: true });
    // A self-closing node is no one's parent: its next sibling still hangs off the list.
    expect(nodes[6]?.parent).toBe(1);
    expect(parseUiDump(uiDump(1, uiNode({}))).rotation).toBe(1);
    expect(() => parseUiDump("ERROR: could not get idle state.\n")).toThrow(
        "uiautomator could not read the phone's screen (ERROR: could not get idle state.).",
    );
});

test("the listing names each control, a row by the words inside it, and does not repeat those words", () => {
    const { elements, total } = phoneElements(parseUiDump(SETTINGS_DUMP), undefined);
    expect(total).toBe(6);
    const lines = elements.map((element) => describeElement(element, element.center));
    expect(lines).toEqual([
        "e1 RecyclerView id=recycler_view at 540,1300 [focusable scrollable]",
        'e2 LinearLayout contains "Network & internet · Wi\u2011Fi, \\"mobile\\"" at 540,300 [clickable]',
        "e3 Switch id=switch_widget at 970,460 [clickable checked]",
        "e4 ImageButton id=fab at 960,2180 [clickable]",
        "e5 EditText id=search at 540,570 [clickable focusable focused]",
        'e6 TextView "Version 1.0" at 220,730',
    ]);
    // A query finds what the plain listing folds away, by text, id or class.
    expect(phoneElements(parseUiDump(SETTINGS_DUMP), "internet").elements.map((element) => element.label)).toEqual(["Network & internet"]);
    expect(phoneElements(parseUiDump(SETTINGS_DUMP), "SWITCH").elements.map((element) => element.ref)).toEqual(["e1"]);
});

test("typed text is sent as `input text` the phone's shell and Android both read back exactly", () => {
    expect(inputTextCommand("hello")).toBe("input text 'hello'");
    // A space survives `input text` only as %s; a quote and the shell's own characters only inside single quotes.
    expect(inputTextCommand("it's a $HOME; rm *|x")).toBe(`input text 'it'\\''s%sa%s$HOME;%srm%s*|x'`);
    // A literal "%s" would be read as a space, so it is split across two calls.
    expect(inputTextCommand("100%sure")).toBe("input text '100%' && input text 'sure'");
    expect(inputTextCommand("50% off")).toBe("input text '50%%soff'");
    // Newlines and tabs are pressed as their keys; "\r\n" is one Enter.
    expect(inputTextCommand("ls\r\nexit\n")).toBe("input text 'ls' && input keyevent 66 && input text 'exit' && input keyevent 66");
    expect(inputTextCommand("a\tb")).toBe("input text 'a' && input keyevent 61 && input text 'b'");
    expect(() => inputTextCommand("café")).toThrow(/plain ASCII only, and this text holds "é" \(U\+00E9\)/);
    expect(() => inputTextCommand("hi 👋")).toThrow(/U\+1F44B/);
    expect(() => inputTextCommand("")).toThrow(AndroidError);
});

test("a key is a KEYCODE_ name, a desktop name or a number; keys that lock the phone are refused", () => {
    expect(keyEventFor("ENTER")).toBe("KEYCODE_ENTER");
    expect(keyEventFor("Return")).toBe("KEYCODE_ENTER");
    expect(keyEventFor("keycode_volume_up")).toBe("KEYCODE_VOLUME_UP");
    expect(keyEventFor("BackSpace")).toBe("KEYCODE_DEL");
    expect(keyEventFor("66")).toBe("66");
    expect(() => keyEventFor("POWER")).toThrow(/^Refused: KEYCODE_POWER turns the phone's screen off and locks it/);
    expect(() => keyEventFor("KEYCODE_SLEEP")).toThrow(/Refused: KEYCODE_SLEEP/);
    expect(() => keyEventFor("26")).toThrow(/Refused: 26 \(KEYCODE_POWER\)/);
    expect(() => keyEventFor("0223")).toThrow(/KEYCODE_SLEEP/);
    expect(() => keyEventFor("ctrl+c")).toThrow(/is not an Android key/);
    expect(() => keyEventFor("HOME; reboot")).toThrow(/is not an Android key/);
});

test("a shell command that presses a lock key is refused like the key itself", () => {
    expect(() => assertNoLockoutCommand("input keyevent 26")).toThrow(/Refused: input keyevent 26 \(KEYCODE_POWER\)/);
    expect(() => assertNoLockoutCommand("sleep 1; input keyevent --longpress POWER")).toThrow(/KEYCODE_POWER/);
    expect(() => assertNoLockoutCommand("input -d 0 keyevent 'KEYCODE_SLEEP'")).toThrow(/KEYCODE_SLEEP/);
    expect(() => assertNoLockoutCommand("input keyevent 3 && echo 26")).not.toThrow();
    expect(() => assertNoLockoutCommand("dumpsys power | grep 26")).not.toThrow();
});

test("what a phone command would lose is named; reading and ordinary work name nothing", () => {
    expect(androidDestructive("pm uninstall com.example.app")).toEqual(["uninstall an app"]);
    expect(androidDestructive("cmd package uninstall -k com.example.app")).toEqual(["uninstall an app"]);
    expect(androidDestructive("pm clear com.example.app")).toEqual(["clear an app's data"]);
    expect(androidDestructive("rm -r /sdcard/DCIM/old")).toEqual(["delete files recursively"]);
    expect(androidDestructive("cd /sdcard && rm -f -R Download/tmp")).toEqual(["delete files recursively"]);
    expect(androidDestructive("settings put global animator_duration_scale 0")).toEqual(["change a system setting"]);
    expect(androidDestructive("svc wifi disable")).toEqual(["switch a phone service (svc), which can cut off its network or this link"]);
    expect(androidDestructive("sync; reboot")).toEqual(["reboot the phone"]);
    expect(androidDestructive("su -c 'reboot recovery'")).toEqual(["reboot the phone"]);
    expect(androidDestructive("wipe data")).toEqual(["wipe the phone's data"]);
    expect(androidDestructive("am broadcast -a android.intent.action.MASTER_CLEAR")).toEqual(["wipe the phone's data"]);
    for (const harmless of [
        "pm list packages -3",
        "settings get global adb_enabled",
        "rm /sdcard/window_dump.xml",
        "ls /data/local/tmp/reboot-notes",
        "getprop sys.boot_completed",
        "dumpsys battery",
        'echo "pm uninstall is how you remove an app"',
    ]) {
        expect(androidDestructive(harmless), harmless).toEqual([]);
    }
});
