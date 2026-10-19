import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyringPaths } from "../address.js";
import { KEYRING_RESPONSES } from "../protocol.js";
import { keyringHarness } from "../testing.js";
import { noTypist } from "../typing/typist.js";
import { serveDoor } from "./channel.js";
import { HelperCallSchema } from "./door.js";
import { answerCall, type Hands, proofFor } from "./helper.js";
import { LineSocket } from "./lines.js";
import { HelperLink, remoteChoicePrompt, remoteHello, remotePassphrasePrompt, remoteValuePrompt } from "./remote.js";
import { provenBy } from "./service-run.js";

/* The Linux door (a unix socket), a helper let in before setup to enrol Windows Hello, and the type-once box and the
   choice dialog carried from the service to the helper. The helper's hands are fakes; nothing here shows a dialog. */

const RECOVERY = "01234-56789-ABCDE-FGHJK-MNPQR-STVWX";

const hands: Hands = {
    hello: {
        available: () => Promise.resolve(true),
        enrol: () => Promise.resolve({ ok: true, value: { signature: Buffer.from("signed"), publicKey: "AAAA" } }),
        sign: () => Promise.resolve({ ok: true, value: Buffer.from("signed") }),
        verify: () => Promise.resolve({ ok: true, value: true }),
    },
    // A person typing the recovery key in lower case, with spaces.
    passphrase: () => Promise.resolve({ kind: "answered", passphrase: RECOVERY.toLowerCase().replaceAll("-", " ") }),
    value: (notice) => Promise.resolve({ kind: "answered", value: "s3cret", remember: notice.remember, username: "ada" }),
    // A person pressing the last button offered.
    choose: (notice) => Promise.resolve({ kind: "chosen", id: notice.choices.at(-1)?.id ?? "" }),
    typist: noTypist("no typing in this test"),
};

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "door-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("the Linux door is a unix socket made 0600, answering a request that brings the token", async () => {
    const path = join(dir, "door.sock");
    const token = randomBytes(32).toString("base64url");
    const { server, port } = await serveDoor(
        { handler: keyringHarness([]).keyring, link: new HelperLink(), token, challenge: () => Promise.resolve({ method: "unset" }), proven: () => Promise.resolve(false), log: () => undefined },
        { kind: "unix", path },
    );
    try {
        expect(port).toBeUndefined();
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        const socket = connect(path);
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        const lines = new LineSocket(socket);
        lines.send({ door: token, as: "request" });
        lines.send({ op: "state" });
        expect(await lines.nextOf(KEYRING_RESPONSES.state, 5000)).toMatchObject({ ok: true, setUp: false });
    } finally {
        server.close();
    }
});

test("before setup a helper is let in unproven, enrols Hello for the service, and shows the type-once box and the choice dialog", async () => {
    const path = join(dir, "door.sock");
    const token = randomBytes(32).toString("base64url");
    const link = new HelperLink();
    const { server } = await serveDoor(
        {
            handler: keyringHarness([]).keyring,
            link,
            token,
            challenge: () => Promise.resolve({ method: "unset" }),
            proven: (challenge, proof) => Promise.resolve(challenge.method === "unset" && proof.method === "unset"),
            log: () => undefined,
        },
        { kind: "unix", path },
    );
    try {
        const socket = connect(path);
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        const helper = new LineSocket(socket);
        helper.send({ door: token, as: "helper" });
        const challenge = JSON.parse((await helper.next(5000)) ?? "{}");
        helper.send(await proofFor(challenge, hands));
        expect(await helper.next(5000)).toBe(JSON.stringify({ ok: true }));
        void (async () => {
            for (;;) {
                const call = await helper.nextOf(HelperCallSchema, 5000);
                if (call === undefined) {
                    return;
                }
                helper.send({ id: call.id, reply: await answerCall(hands, call) });
            }
        })();
        const hello = remoteHello(link, () => Promise.resolve(undefined));
        expect(await hello.available()).toBe(true);
        const enrolled = await hello.enrol("intentic-keyring", "Y2hhbGxlbmdl", { title: "Set up Passwords", message: "m" });
        expect(enrolled).toEqual({ ok: true, value: { signature: Buffer.from("signed"), publicKey: "AAAA" } });
        expect(await remoteValuePrompt(link)({ title: "Save", message: "m", remember: true, username: {} })).toEqual({ kind: "answered", value: "s3cret", remember: true, username: "ada" });
        const choices = [
            { id: "once", label: "Allow once" },
            { id: "deny", label: "Deny" },
        ];
        expect(await remoteChoicePrompt(link)({ title: "Let it sign in?", message: "m", choices })).toEqual({ kind: "chosen", id: "deny" });
        // The recovery key comes back as the vault was wrapped with it, however it was typed.
        expect(await remotePassphrasePrompt(link)({ title: "Unlock", message: "m" })).toEqual({ kind: "answered", passphrase: RECOVERY });
        helper.end();
    } finally {
        server.close();
    }
});

test("once a Hello key is pinned, a helper cannot enrol another", async () => {
    const link = new HelperLink();
    const enrolled = await remoteHello(link, () => Promise.resolve({ credential: "c", publicKey: "k" })).enrol("c", "Y2hhbGxlbmdl", { title: "t", message: "m" });
    expect(enrolled).toMatchObject({ ok: false });
});

test("a helper proves itself as each challenge asks", async () => {
    expect(await proofFor({ method: "polkit" }, hands, 4242)).toEqual({ method: "polkit", pid: 4242 });
    expect(await proofFor({ method: "unset" }, hands)).toEqual({ method: "unset" });
    expect(await proofFor({ method: "passphrase" }, hands)).toEqual({ method: "passphrase", passphrase: RECOVERY });
    expect(await proofFor({ method: "hello", credential: "c", challenge: "x" }, hands)).toEqual({ method: "hello", signature: Buffer.from("signed").toString("base64") });
});

test("an unproven helper is let in only while no vault exists, and only to an `unset` challenge", async () => {
    const files = keyringPaths(dir, "linux");
    const run = { proven: () => Promise.resolve(false) };
    expect(await provenBy(run, files, { method: "unset" }, { method: "unset" })).toBe(true);
    expect(await provenBy(run, files, { method: "polkit" }, { method: "unset" })).toBe(false);
    expect(await provenBy(run, files, { method: "polkit" }, { method: "declined" })).toBe(false);
});
