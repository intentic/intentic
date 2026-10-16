import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askKeyring } from "./client.js";
import { sealForKeyring } from "./seal.js";
import { serveKeyring } from "./server.js";
import { keyringHarness, passwordRules } from "./testing.js";

describe("the keyring's pipe", () => {
    test("answers each op over a unix socket only this user can open", async () => {
        const dir = await mkdtemp(join(tmpdir(), "keyring-"));
        const address = join(dir, "keyring.sock");
        const h = keyringHarness([]);
        const server = await serveKeyring(h.keyring, address, () => undefined, "linux");
        try {
            expect(((await stat(address)).mode & 0o777).toString(8)).toBe("600");
            expect(await askKeyring({ address }, { op: "setup", passphrase: "correct horse battery staple", hello: false })).toEqual({ ok: true });
            const state = await askKeyring({ address }, { op: "state" });
            expect(state).toMatchObject({ ok: true, setUp: true });
            const inbox = state.ok && "state" in state ? state.state.keys?.inbox : undefined;
            expect(inbox).toEqual(expect.any(String));
            const sealed = sealForKeyring(inbox ?? "", "SSH_PROD", "ssh-prod-password");
            expect(await askKeyring({ address }, { op: "add", name: "SSH_PROD", sealed, rules: passwordRules({ askpass: ["ssh:radar@prod"] }), replace: false })).toEqual({ ok: true });
            expect(await askKeyring({ address }, { op: "askpass", prompt: "radar@prod's password: " })).toEqual({ ok: true, value: "ssh-prod-password" });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("a request it cannot read is answered with a refusal, not a dropped connection", async () => {
        const dir = await mkdtemp(join(tmpdir(), "keyring-"));
        const address = join(dir, "keyring.sock");
        const server = await serveKeyring(keyringHarness([]).keyring, address, () => undefined, "linux");
        try {
            const { connect } = await import("node:net");
            const answer = await new Promise<string>((resolve) => {
                const socket = connect(address, () => socket.write('{"op":"open-sesame"}\n'));
                let text = "";
                socket.setEncoding("utf8");
                socket.on("data", (chunk: string) => {
                    text += chunk;
                });
                socket.on("end", () => resolve(text));
            });
            expect(JSON.parse(answer)).toMatchObject({ ok: false, code: "bad-grant" });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(dir, { recursive: true, force: true });
        }
    });
});
