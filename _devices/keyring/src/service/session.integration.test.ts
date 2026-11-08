import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyringPaths } from "../address.js";
import { type PassphraseNotice, WRONG_RECOVERY_KEY } from "../consent/consent.js";
import { KEYRING_RESPONSES } from "../protocol.js";
import { keyringHarness } from "../testing.js";
import { noTypist } from "../typing/typist.js";
import { serveDoor } from "./channel.js";
import { type Challenge, HelperCallSchema, type Proof } from "./door.js";
import { answerCall, type Hands, keepProving, proofFor } from "./helper.js";
import { LineSocket } from "./lines.js";
import { ProofGate } from "./proof-gate.js";
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
    expect(await proofFor({ method: "polkit" }, hands, { pid: 4242 })).toEqual({ method: "polkit", pid: 4242 });
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

/* THE HELPER'S PROOF, over and over (keepProving): a recovery key that did not open the vault asked for again at once,
   saying so; and a helper turned down that looks again, asking nobody, when the service behind the door restarts (a
   reset), so setup finds it there to enrol Windows Hello. */

const eventually = async (check: () => boolean, deadlineMs = 5000): Promise<void> => {
    const until = Date.now() + deadlineMs;
    while (!check()) {
        if (Date.now() > until) {
            throw new Error("did not happen in time");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// A service behind a unix door of its own, its door file written where the helper reads it.
const serviceAt = async (doorFile: string, path: string, challenge: Challenge, proven: (proof: Proof) => boolean) => {
    const token = randomBytes(32).toString("base64url");
    const link = new HelperLink();
    const { server } = await serveDoor(
        { handler: keyringHarness([]).keyring, link, token, challenge: () => Promise.resolve(challenge), proven: (_asked, proof) => Promise.resolve(proven(proof)), log: () => undefined },
        { kind: "unix", path },
    );
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => sockets.add(socket));
    await writeFile(doorFile, `${JSON.stringify({ socket: path, token, pid: process.pid })}\n`);
    return {
        link,
        close: () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            if (server.listening) {
                server.close();
            }
        },
    };
};

// A person at the box: answers each recovery-key box from `typing` in turn (cancelling once it runs out), noting each.
const person = (typing: string[]) => {
    const notices: PassphraseNotice[] = [];
    const at: Hands = {
        ...hands,
        passphrase: (notice) => {
            notices.push(notice);
            const typed = typing.shift();
            return Promise.resolve(typed === undefined ? { kind: "cancelled" } : { kind: "answered", passphrase: typed });
        },
    };
    return { notices, hands: at };
};

const opensWith = (proof: Proof): boolean => proof.method === "passphrase" && proof.passphrase === RECOVERY;

const proving = (doorFile: string, at: Hands, lines: string[] = []) => {
    const stop = new AbortController();
    const gate = new ProofGate();
    const done = keepProving({ doorFile, hands: at, gate, log: (line) => lines.push(line), asked: () => undefined, retryMs: 20, signal: stop.signal });
    return {
        gate,
        stop: async (): Promise<void> => {
            stop.abort();
            await done;
        },
    };
};

test("a recovery key that did not open the vault is asked for again at once, saying so", async () => {
    const doorFile = join(dir, "door.json");
    const service = await serviceAt(doorFile, join(dir, "a.sock"), { method: "passphrase" }, opensWith);
    const at = person(["my-own-passphrase", RECOVERY]);
    const helper = proving(doorFile, at.hands);
    try {
        await eventually(() => helper.gate.proven);
        expect(service.link.ready).toBe(true);
        expect(at.notices.map((notice) => notice.problem)).toEqual([undefined, WRONG_RECOVERY_KEY]);
    } finally {
        service.close();
        await helper.stop();
    }
});

test("after three keys that did not open it, the box waits for the next need, and then asks afresh", async () => {
    const doorFile = join(dir, "door.json");
    const service = await serviceAt(doorFile, join(dir, "a.sock"), { method: "passphrase" }, opensWith);
    const at = person(["one", "two", "three", RECOVERY]);
    const lines: string[] = [];
    const helper = proving(doorFile, at.hands, lines);
    try {
        await eventually(() => lines.includes("not asking again until something needs a person here"));
        expect(at.notices.map((notice) => notice.problem)).toEqual([undefined, WRONG_RECOVERY_KEY, WRONG_RECOVERY_KEY]);
        helper.gate.want();
        await eventually(() => helper.gate.proven);
        expect(at.notices.at(-1)?.problem).toBeUndefined();
    } finally {
        service.close();
        await helper.stop();
    }
});

test("a helper turned down looks again, asking nobody, when the service restarts with no vault, and is let in", async () => {
    const doorFile = join(dir, "door.json");
    const before = await serviceAt(doorFile, join(dir, "a.sock"), { method: "passphrase" }, opensWith);
    const at = person([]);
    const lines: string[] = [];
    const helper = proving(doorFile, at.hands, lines);
    try {
        await eventually(() => lines.includes("the person did not prove this session"));
        // Started over: the old service gone, a new one with no vault, behind a new door.
        before.close();
        const after = await serviceAt(doorFile, join(dir, "b.sock"), { method: "unset" }, (proof) => proof.method === "unset");
        try {
            await eventually(() => helper.gate.proven);
            expect(after.link.ready).toBe(true);
            expect(at.notices).toHaveLength(1);
        } finally {
            after.close();
        }
    } finally {
        before.close();
        await helper.stop();
    }
});

test("a restarted service that wants a person is passed over without a box, until something needs one", async () => {
    const doorFile = join(dir, "door.json");
    const before = await serviceAt(doorFile, join(dir, "a.sock"), { method: "passphrase" }, opensWith);
    const at = person([]);
    const lines: string[] = [];
    const helper = proving(doorFile, at.hands, lines);
    try {
        await eventually(() => lines.includes("the person did not prove this session"));
        before.close();
        const after = await serviceAt(doorFile, join(dir, "b.sock"), { method: "passphrase" }, opensWith);
        try {
            await eventually(() => lines.includes("the service wants a person: not asking until something needs one"));
            expect(at.notices).toHaveLength(1);
            helper.gate.want();
            await eventually(() => at.notices.length === 2);
        } finally {
            after.close();
        }
    } finally {
        before.close();
        await helper.stop();
    }
});

test("the helper's recovery-key box says what went wrong with the last key", async () => {
    const at = person([RECOVERY]);
    await proofFor({ method: "passphrase" }, at.hands, { problem: WRONG_RECOVERY_KEY });
    expect(at.notices[0]).toMatchObject({ problem: WRONG_RECOVERY_KEY });
});
