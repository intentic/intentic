import { clipboardScript, launchScript } from "./apps-windows.js";
import { actScript } from "./elements-windows.js";
import { typeScript } from "./input-windows.js";

/* The command lines the Windows backend hands powershell.exe, with text an agent chose in them. PowerShell reads ‘ ’ ‚ ‛
   as single quotes as well as ', and `$(...)` and backticks inside double quotes, so any text interpolated into a
   literal can end it and run what follows. Measured on omen (Windows PowerShell 5.1): the value `x’); Write-Output
   INJECTED; (‘y` doubled only ASCII quotes and printed INJECTED. Text must therefore travel as data, and never appear
   in the command line as itself. */

const TEXTS = [
    "It’s fine",
    "x’); Write-Output INJECTED; (‘y",
    "‚low‛ ‘high’",
    "plain 'ascii' quote",
    'double "quotes" and $(Write-Output INJECTED) and `backticks`',
    "naïve 日本語 ✓",
    "line one\nline two",
    "",
];

// What a command line may hold between quotes: base64 and nothing else, but the one fixed key the script itself presses.
const literalsOf = (script: string): string[] => [...script.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "").filter((literal) => literal !== "{ENTER}");

describe.each(TEXTS)("text %j", (text) => {
    const scripts: Record<string, string> = {
        "ui_act set_value": actScript("12345", "42.7.1", "set_value", text),
        "clipboard write": clipboardScript(text),
        type: typeScript(text),
        launch: launchScript(text),
    };
    for (const [what, script] of Object.entries(scripts)) {
        test(`${what} carries it as base64 data, never as itself`, () => {
            if (text !== "") {
                expect(script).not.toContain(text);
            }
            expect(script).not.toMatch(/[‘’‚‛]/);
            // Every quoted literal in the line is either a fixed word the script wrote or base64.
            for (const literal of literalsOf(script)) {
                expect(literal).toMatch(/^[A-Za-z0-9+/=]*$/);
            }
        });
    }
});

test("the data decodes to the exact text, newlines and unicode included", () => {
    const decoded = (script: string): string[] =>
        literalsOf(script)
            .filter((literal) => literal !== "" && /^[A-Za-z0-9+/]+={0,2}$/.test(literal))
            .map((literal) => Buffer.from(literal, "base64").toString("utf8"));
    expect(decoded(clipboardScript("naïve 日本語 ✓"))).toContain("naïve 日本語 ✓");
    expect(decoded(launchScript("C:\\Program Files\\x y\\app.exe"))).toContain("C:\\Program Files\\x y\\app.exe");
    expect(decoded(actScript("1", "4.2", "set_value", "It’s fine"))).toContain("It’s fine");
});
