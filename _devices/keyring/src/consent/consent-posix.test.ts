import type { RunRequest } from "../run.js";
import { chosenId, linuxChoicePrompt, linuxValuePrompt, zenityChoiceArgs, zenityValueAnswer, zenityValueArgs } from "./consent-posix.js";

/* The type-once box on Linux: zenity's form asked and read back, and kdialog's two dialogs where zenity is missing. And
   the choice dialog an agent's need is answered in. */

const NOTICE = { title: "Save a password", message: "FortiClient asks for a password.", remember: true } as const;
const SEP = "\u001f";

test("the form asks a user name only when one is wanted and not known, and starts Remember as the source says", () => {
    expect(zenityValueArgs(NOTICE)).not.toContain("--add-entry=User name");
    expect(zenityValueArgs({ ...NOTICE, username: {} })).toContain("--add-entry=User name");
    expect(zenityValueArgs({ ...NOTICE, remember: false })).toContain("--combo-values=No|Yes");
    expect(zenityValueArgs({ ...NOTICE, username: { value: "ada" } }).find((arg) => arg.startsWith("--text="))).toContain("User name: ada");
});

test("the form's answer reads back, an untouched choice keeping the default", () => {
    expect(zenityValueAnswer(`s3cret${SEP}No\n`, NOTICE)).toEqual({ kind: "answered", value: "s3cret", remember: false });
    expect(zenityValueAnswer(`s3cret${SEP}\n`, NOTICE)).toEqual({ kind: "answered", value: "s3cret", remember: true });
    expect(zenityValueAnswer(`ada${SEP}s3cret${SEP}Yes\n`, { ...NOTICE, username: {} })).toEqual({ kind: "answered", value: "s3cret", remember: true, username: "ada" });
    expect(zenityValueAnswer(`s3cret${SEP}Yes`, { ...NOTICE, username: { value: "ada" } })).toEqual({ kind: "answered", value: "s3cret", remember: true, username: "ada" });
    expect(zenityValueAnswer(`${SEP}Yes`, NOTICE)).toEqual({ kind: "cancelled" });
});

test("without zenity, kdialog asks the value and then whether to remember it; with no display, nothing is shown", async () => {
    const ran: RunRequest[] = [];
    const prompt = linuxValuePrompt(
        (request) => {
            ran.push(request);
            const missing = request.command === "zenity";
            const yesno = request.args.includes("--yesno");
            return Promise.resolve({ exitCode: missing ? null : yesno ? 1 : 0, stdout: yesno ? "" : "s3cret\n", stderr: "", timedOut: false, missing, startError: undefined });
        },
        { DISPLAY: ":0" },
    );
    expect(await prompt(NOTICE)).toEqual({ kind: "answered", value: "s3cret", remember: false });
    expect(ran.map((request) => request.command)).toEqual(["zenity", "kdialog", "kdialog"]);
    expect(await linuxValuePrompt(() => Promise.reject(new Error("not run")), {})(NOTICE)).toMatchObject({ kind: "unavailable" });
});

const NEED = {
    title: "Let intentic-dev's agent sign in?",
    message: "intentic-dev's agent wants to sign in to github.com",
    choices: [
        { id: "once", label: "Allow once" },
        { id: "always", label: "Always" },
        { id: "deny", label: "Deny" },
    ],
} as const;

test("the choice dialog offers each answer, the first selected, and reads the label back to its id", async () => {
    const args = zenityChoiceArgs(NEED);
    expect(args.slice(args.indexOf("TRUE"), args.indexOf("TRUE") + 6)).toEqual(["TRUE", "Allow once", "FALSE", "Always", "FALSE", "Deny"]);
    expect(chosenId(NEED, "Always\n")).toBe("always");
    expect(chosenId(NEED, "Something else")).toBeUndefined();
    const run = (stdout: string, exitCode: number) => () => Promise.resolve({ exitCode, stdout, stderr: "", timedOut: false, missing: false, startError: undefined });
    expect(await linuxChoicePrompt(run("Deny\n", 0), { DISPLAY: ":0" })(NEED)).toEqual({ kind: "chosen", id: "deny" });
    expect(await linuxChoicePrompt(run("", 1), { DISPLAY: ":0" })(NEED)).toEqual({ kind: "cancelled" });
    expect(await linuxChoicePrompt(() => Promise.reject(new Error("not run")), {})(NEED)).toMatchObject({ kind: "unavailable" });
});
