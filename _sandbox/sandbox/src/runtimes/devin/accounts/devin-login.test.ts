import { keyOf, landingOf, signInUrlOf, statusFacts } from "./devin-login.js";

/* What the daemon reads off Devin's CLI while it signs an account in: its page, the key it writes, who it says this is. */

// As the CLI prints it under `script`: the link wrapped in an OSC 8 hyperlink, lines ended by the terminal's CR LF.
const PROMPT =
    "Visit \u001b]8;;https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1\u001b\\https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1\u001b]8;;\u001b\\ to sign in, then copy the code and paste it below.\r\n\r\n";

test("the sign-in page is read once, without the terminal's hyperlink wrapping", () => {
    expect(signInUrlOf(PROMPT)).toBe("https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1");
    expect(signInUrlOf("Starting…\r\n")).toBeUndefined();
});

test("the key comes from the credentials file the CLI wrote, and an empty file has none", () => {
    expect(keyOf(`windsurf_api_key = "devin-abc"\n`)).toBe("devin-abc");
    expect(keyOf(`other = "x"\n`)).toBeUndefined();
});

test("who is signed in is read off the status, and a status that names nobody gives nothing", () => {
    // As `devin auth status` 3000.11 prints it.
    const status = [
        "Logged in (via Devin).",
        "",
        "User:",
        "  Name:              Dev",
        "  Email:             dev@example.com",
        "",
        "Account:",
        "  Tier:              Devin Free",
        "  Plan:              Free",
        "",
    ].join("\n");
    expect(statusFacts(status)).toEqual({ email: "dev@example.com", plan: "Free" });
    expect(statusFacts("Logged in.\n")).toEqual({});
});

test("the browser page's landing is its loopback redirect and state; the manual page has none", () => {
    const browser = "https://app.devin.ai/auth/cli/continue?redirect_uri=http%3A%2F%2F127.0.0.1%3A45267%2Fcallback&state=s1&code_challenge=c1";
    expect(landingOf(browser)).toEqual({ host: "127.0.0.1", port: 45267, path: "/callback", state: "s1" });
    expect(landingOf("https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1")).toBeUndefined();
    // A redirect off this machine is no landing the CLI could be listening for.
    expect(landingOf("https://app.devin.ai/x?redirect_uri=https%3A%2F%2Fevil.example%2Fcallback&state=s1")).toBeUndefined();
});
