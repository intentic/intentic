import { commandTitle, remembersPrompt } from "./prompt-capture.js";
import { foregroundCommand } from "./terminal-capture.js";

// Which hidden prompts are worth remembering, and the words a capture is named by. netd edits the line itself (its
// term/hidden.rs has those tests); the capture's way to the owner's computer is terminal-capture.test.ts.

describe("which prompts are remembered", () => {
    test.each(["Password:", "Password for npm:", "[sudo] password for radar:", "Enter passphrase for key '/root/.ssh/id_ed25519':", "Passwort:", "radar@build-01's password:"])(
        "%s is a password prompt",
        (prompt) => expect(remembersPrompt(prompt)).toBe(true),
    );
    test.each(["Enter OTP:", "Enter one-time password:", "Verification code:", "2FA code:", "Authenticator code:", "Enter the 6-digit code:", "One-time password (OTP):", "PIN:", "$ ", "Username:"])(
        "%s is not",
        (prompt) => expect(remembersPrompt(prompt)).toBe(false),
    );
    test("a capture is titled by the command that asked", () => {
        expect(commandTitle("npm login --registry=https://r.example")).toBe("npm login");
        expect(commandTitle("radar@box:~$ ssh build-01")).toBe("ssh build-01");
        expect(commandTitle(undefined)).toBeUndefined();
    });
    test("ps's foreground says which program is asking", () => {
        expect(foregroundCommand("Ss   -zsh\nS+   npm login\n")).toBe("npm login");
    });
});
