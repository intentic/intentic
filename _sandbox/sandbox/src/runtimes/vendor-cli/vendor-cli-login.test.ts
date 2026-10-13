import { deviceCodeOf, lastWords } from "./vendor-cli-login.js";

/* What the daemon reads off a vendor CLI's device login: its page and code, and its last words when it fails. */

// As `kimi login` 2.1.1 prints it on stderr.
const KIMI = [
    "",
    "Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=YZOJ-J7NR",
    "If the browser did not open, paste the URL above and enter code: YZOJ-J7NR",
    "Code expires in 1800s.",
    "Waiting for authorization to complete…",
    "",
].join("\n");

// As `grok login --device-auth` 1.0.52 prints it on stdout, its hint in dim grey.
const GROK = [
    "",
    "To sign in, open this URL in your browser:",
    "",
    "  https://accounts.x.ai/oauth2/device?user_code=K4TC-VC3F",
    "",
    "  (Could not open browser automatically — open the URL above manually.)",
    "",
    "Confirm this code in your browser:",
    "",
    "  K4TC-VC3F",
    "",
    "\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m",
    "",
    "Waiting for authorization...",
].join("\r\n");

test("the page and code are read off either vendor's device login", () => {
    expect(deviceCodeOf(KIMI)).toEqual({ url: "https://www.kimi.com/code/authorize_device?user_code=YZOJ-J7NR", code: "YZOJ-J7NR" });
    expect(deviceCodeOf(GROK)).toEqual({ url: "https://accounts.x.ai/oauth2/device?user_code=K4TC-VC3F", code: "K4TC-VC3F" });
});

test("nothing is offered until both the page and a code are out", () => {
    expect(deviceCodeOf("Starting…\n")).toBeUndefined();
    expect(deviceCodeOf("Open https://example.com/device\n")).toBeUndefined();
});

test("a refusal is the CLI's own last line", () => {
    expect(lastWords(`${KIMI}Login failed: access denied\n\n`)).toBe("Login failed: access denied");
    expect(lastWords("")).toBe("");
});
