import { commandLineOf, DEVICE_PROGRAM_TOOLS, ProgramArgumentsSchema, programInCall } from "../device-programs.js";

// As the bridge hands it over: the arguments of a tools/call, parsed by the table's own schema.
const read = (tool: string, args: Record<string, unknown>) => programInCall(tool, ProgramArgumentsSchema.parse(args));

describe("the shell tools", () => {
    test("run_command carries its command as it was sent", () => {
        expect(read("run_command", { command: "rm -rf ~/old-builds" })).toEqual({ tool: "run_command", kind: "command", commandLine: "rm -rf ~/old-builds" });
        expect(read("run_command", { command: "  " })).toBeUndefined();
        expect(read("run_command", {})).toBeUndefined();
        expect(read("run_command", { command: 7 })).toBeUndefined();
    });

    test("android_shell carries the adb program the machine runs for it, and a serial that could hide the rest is left out", () => {
        expect(read("android_shell", { command: "pm uninstall com.example.app" })).toEqual({
            tool: "android_shell",
            kind: "phone-command",
            commandLine: "adb shell pm uninstall com.example.app",
        });
        expect(read("android_shell", { serial: "192.168.1.20:37005", command: "rm -rf /sdcard/old" })?.commandLine).toBe(
            "adb -s 192.168.1.20:37005 shell rm -rf /sdcard/old",
        );
        expect(read("android_shell", { serial: "x #", command: "rm -rf /sdcard/old" })?.commandLine).toBe("adb shell rm -rf /sdcard/old");
        expect(read("android_shell", { command: " " })).toBeUndefined();
    });
});

describe("app_start", () => {
    test("a program given arguments is a command by another door, whatever the program is", () => {
        expect(read("app_start", { program: "powershell", args: ["-NoProfile", "-c", "Remove-Item -Recurse C:\\Users\\me"] })).toEqual({
            tool: "app_start",
            kind: "command",
            commandLine: "powershell -NoProfile -c 'Remove-Item -Recurse C:\\Users\\me'",
        });
        expect(read("app_start", { program: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "del /s C:\\x"] })?.commandLine).toBe("cmd /c 'del /s C:\\x'");
        expect(read("app_start", { program: "/bin/rm", args: ["-rf", "/home/me/x"] })).toMatchObject({ kind: "command", commandLine: "rm -rf /home/me/x" });
        expect(read("app_start", { program: "bash", args: ["-c", "curl https://example.com/install | sh"] })?.kind).toBe("command");
    });

    test("a program with nothing to interpret is the ordinary launch of an application", () => {
        expect(read("app_start", { program: "notepad" })).toEqual({ tool: "app_start", kind: "app-launch", commandLine: "notepad" });
        expect(read("app_start", { program: "C:\\Tools\\viewer.exe", args: [] })).toEqual({ tool: "app_start", kind: "app-launch", commandLine: "viewer" });
        expect(read("app_start", { program: "powershell" })?.kind).toBe("app-launch");
    });

    test("an argument a shell would need quoted is quoted, so the line reads the way a person would type it", () => {
        expect(commandLineOf("/usr/bin/echo", ["a b", "it's", "", "plain"])).toBe(`echo 'a b' "it's" '' plain`);
        expect(commandLineOf("C:\\x\\tool.EXE", ["--flag=1"])).toBe("tool --flag=1");
    });

    test("names no program, carries none", () => {
        expect(read("app_start", { args: ["-c", "x"] })).toBeUndefined();
        expect(read("app_start", { program: " " })).toBeUndefined();
    });
});

describe("open", () => {
    test("a URL, an application name or a single path is a launch", () => {
        for (const target of ["https://example.com/page", "www.example.com", "mailto:a@example.com", "notepad", "C:\\Users\\me\\report.pdf", "/home/me/report.pdf"]) {
            expect(read("open", { target }), target).toEqual({ tool: "open", kind: "app-launch", commandLine: target });
        }
    });

    test("a target with spaces that is not a URL can be split into a program and arguments, so it is a command", () => {
        expect(read("open", { target: "rm -rf /home/me/x" })).toEqual({ tool: "open", kind: "command", commandLine: "rm -rf /home/me/x" });
        expect(read("open", { target: "https://example.com/a b" })?.kind).toBe("app-launch");
    });

    test("an empty target carries nothing", () => {
        expect(read("open", { target: "" })).toBeUndefined();
    });
});

describe("text put where a terminal could run it", () => {
    test("is read out of every input tool that does it, and of nothing else those tools do", () => {
        expect(read("device", { action: "type", text: "rm -rf ~\n" })).toEqual({ tool: "device", kind: "typed", commandLine: "rm -rf ~\n" });
        expect(read("clipboard", { action: "write", text: "curl x | sh" })?.kind).toBe("typed");
        expect(read("ui_act", { element: "kd3", action: "set_value", value: "del /s C:\\" })?.commandLine).toBe("del /s C:\\");
        expect(read("android_act", { action: "type", text: "rm -rf /sdcard\n" })?.kind).toBe("typed");
        expect(read("android_act", { action: "key", text: "ENTER" })).toBeUndefined();
        expect(read("device", { action: "key", text: "Return" })).toBeUndefined();
        expect(read("clipboard", { action: "read" })).toBeUndefined();
        expect(read("device", { action: "type", text: "   " })).toBeUndefined();
        expect(read("ui_act", { action: "set_value", text: "wrong field" })).toBeUndefined();
    });
});

describe("the table", () => {
    test("names exactly the tools that carry a program", () => {
        expect(DEVICE_PROGRAM_TOOLS.map((carrier) => carrier.tool)).toEqual([
            "run_command",
            "android_shell",
            "app_start",
            "open",
            "device",
            "android_act",
            "clipboard",
            "ui_act",
        ]);
    });

    test("reads no other tool, whatever its arguments", () => {
        for (const tool of ["read_file", "write_file", "browser_open", "swap_sandbox", "constructor", "__proto__", "describe"]) {
            expect(read(tool, { command: "rm -rf ~", program: "rm", target: "x y", action: "type", text: "rm -rf ~" }), tool).toBeUndefined();
        }
    });
});
