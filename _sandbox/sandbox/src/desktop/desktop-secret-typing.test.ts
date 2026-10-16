import type { runBounded } from "@intentic/base/process";
import { sandboxDesktopTypist } from "./desktop-secret-typing.js";

/* The one place a secret goes through xdotool: on stdin, never in its arguments, and only into the window that still has
   the keyboard. The runner is faked; the window's program is read off the test process's own /proc entry. */

const VALUE = "hunter2-very-secret";

const fakeRun = (active: string[]) => {
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const output = (text: string) => ({ text, dropped: 0 });
    const run: typeof runBounded = async (_command, args, options = {}) => {
        calls.push({ args, input: options.input });
        const said = args[0] === "getactivewindow" ? (active.shift() ?? "0") : args[0] === "getwindowpid" ? String(process.pid) : args[0] === "getwindowname" ? "ssh deploy@db" : "";
        return { exitCode: 0, exitSignal: null, stdout: output(said), stderr: output(""), timedOut: false, aborted: false, lingering: false };
    };
    return { run, calls };
};

test("the value reaches xdotool on stdin and never in its arguments", async () => {
    const { run, calls } = fakeRun(["4194311", "4194311"]);
    const typist = sandboxDesktopTypist({ run, display: async () => ":42" });
    const focused = await typist.focused();
    expect(focused).toMatchObject({ window: "4194311", title: "ssh deploy@db" });
    expect(await typist.type("4194311", VALUE)).toBe("typed");
    const typing = calls.find((call) => call.args[0] === "type");
    expect(typing).toEqual({ args: ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], input: VALUE });
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(VALUE);
});

test("a window that lost the keyboard gets nothing", async () => {
    const { run, calls } = fakeRun(["4194311", "4194400"]);
    const typist = sandboxDesktopTypist({ run, display: async () => ":42" });
    await typist.focused();
    expect(await typist.type("4194311", VALUE)).toBe("moved");
    expect(calls.some((call) => call.args[0] === "type")).toBe(false);
});

test("no window with the keyboard reads as none", async () => {
    const { run } = fakeRun(["0"]);
    expect(await sandboxDesktopTypist({ run, display: async () => ":42" }).focused()).toBeUndefined();
});
