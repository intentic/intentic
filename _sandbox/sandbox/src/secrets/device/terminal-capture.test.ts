import { newSealKeyPair, unseal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringCaptureItem, KeyringCaptureResult } from "@intentic/sandbox-contract/schemas/keyring";
import { waitFor } from "@intentic/testing/bun";
import type { KeyringComputer } from "./keyring-link.js";
import { createTerminalCapture, type PaneFacts } from "./terminal-capture.js";

// A password netd saw typed at a hidden prompt in one of the editor's terminals (`ToNode::HiddenLine`): sealed to the
// inbox of the computer that remembers from sandboxes and sent once, the pane told where it went; never for an agent's
// session, a question that was not a password's, or when no computer of the owner's keeps one.

const SANDBOX = "https://intentic-dev.intentic.app";

const harness = (computers: readonly KeyringComputer[]) => {
    const sent: { machine: string; item: KeyringCaptureItem }[] = [];
    const notices: string[] = [];
    const pane: PaneFacts = {
        command: () => Promise.resolve("npm login"),
        notice: (_session, text) => {
            notices.push(text);
            return Promise.resolve();
        },
    };
    const capture = (machine: string, item: KeyringCaptureItem): Promise<KeyringCaptureResult> => {
        sent.push({ machine, item });
        return Promise.resolve({ ok: true, outcome: "saved", name: "NPM_LOGIN", title: "npm login" });
    };
    const link = {
        sandboxUrl: () => Promise.resolve(SANDBOX),
        computers: () => Promise.resolve(computers),
        passwords: { capture, need: () => Promise.reject(new Error("unused")), phonePair: () => Promise.reject(new Error("unused")), phoneFill: () => Promise.reject(new Error("unused")) },
    };
    const warned: unknown[] = [];
    return { terminal: createTerminalCapture({ link, pane, logger: { warn: (...args: unknown[]) => warned.push(args) } }), sent, notices, warned };
};

const rog = (inbox: string, sandbox = true): KeyringComputer => ({
    machine: "rog",
    online: true,
    setUp: true,
    locked: false,
    remember: { browser: false, terminal: false, apps: false, phone: false, sandbox },
    inbox,
    activeAt: 1,
});

describe("a hidden line netd reports", () => {
    test("is sealed to the remembering computer's inbox, sent once, and the pane told where it went", async () => {
        const keys = newSealKeyPair();
        const h = harness([rog(keys.publicKey)]);
        h.terminal.entered("web-abc", "Password:", "npm-secret-value");
        await waitFor(() => expect(h.notices).toHaveLength(1));
        expect(h.sent).toHaveLength(1);
        const [first] = h.sent;
        if (first === undefined) {
            throw new Error("nothing sent");
        }
        const { machine, item } = first;
        expect(machine).toBe("rog");
        expect(item).toMatchObject({ origin: { kind: "prompt", text: "Password:", command: "npm login", sandbox: SANDBOX }, source: "terminal", via: "intentic-dev", title: "npm login" });
        expect(JSON.stringify(item)).not.toContain("npm-secret-value");
        expect(unseal(keys, item.sealed, { kind: "capture", via: item.via, at: item.at })).toBe("npm-secret-value");
        expect(h.notices).toEqual(["Saved 'npm login' to Passwords on rog"]);
    });

    test("an agent's session, a question that is not a password's, or no remembering computer sends nothing", async () => {
        const keys = newSealKeyPair();
        const h = harness([rog(keys.publicKey)]);
        h.terminal.entered("agent-1", "Password:", "agent-typed-value");
        h.terminal.entered("web-abc", "Username:", "radar");
        h.terminal.entered("web-abc", "Enter your one-time password:", "123456");
        const off = harness([rog(keys.publicKey, false)]);
        off.terminal.entered("web-abc", "Password:", "kept-nowhere-value");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(h.sent).toEqual([]);
        expect(off.sent).toEqual([]);
    });
});
