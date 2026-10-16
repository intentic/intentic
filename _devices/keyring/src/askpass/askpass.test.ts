import { askpassMatch, parseAskpassPrompt } from "./askpass.js";
import { startedAsAskpass } from "./askpass-run.js";

describe("askpass prompts", () => {
    test.each([
        ["radar@10.0.0.5's password: ", "secret", "ssh:radar@10.0.0.5"],
        ["(radar@Prod.example.com) Password: ", "secret", "ssh:radar@prod.example.com"],
        ["Enter passphrase for key '/home/radar/.ssh/id_ed25519': ", "secret", "ssh-key:/home/radar/.ssh/id_ed25519"],
        ["[sudo] password for radar: ", "secret", "sudo:radar"],
        ["Password for 'https://radar@github.com': ", "secret", "git:https://github.com"],
        ["Username for 'https://github.com': ", "username", "git:https://github.com"],
    ] as const)("%s reads as %s, matched by %s", (prompt, wants, matcher) => {
        const question = parseAskpassPrompt(prompt);
        expect(question.wants).toBe(wants);
        expect(question.matchers[0]).toBe(matcher);
    });

    test("sudo falls back to the plain `sudo` matcher", () => {
        expect(askpassMatch(parseAskpassPrompt("[sudo] password for radar: "), ["sudo"])).toBe("sudo");
    });

    test("anything else is matched by its words, case and trailing colon aside", () => {
        expect(askpassMatch(parseAskpassPrompt("VPN token for Corp?"), ["prompt:vpn token for corp"])).toBe("prompt:vpn token for corp");
    });

    test("a host is matched without case, a user exactly", () => {
        expect(askpassMatch(parseAskpassPrompt("radar@HOST's password: "), ["ssh:radar@host"])).toBe("ssh:radar@host");
        expect(askpassMatch(parseAskpassPrompt("root@host's password: "), ["ssh:radar@host"])).toBeUndefined();
    });

    test("the binary knows it was started as intentic-askpass", () => {
        expect(startedAsAskpass("C:\\Users\\r\\.intentic\\machine\\bin\\intentic-askpass.exe", undefined)).toBe(true);
        expect(startedAsAskpass("/usr/bin/bun", "/home/r/.intentic/machine/bin/intentic-keyring")).toBe(false);
    });
});
