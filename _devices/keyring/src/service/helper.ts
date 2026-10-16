import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { sleep } from "@intentic/base/async";
import { claimPidFile } from "@intentic/local-agent";
import { keyringPaths } from "../address.js";
import type { HelloDriver, PassphrasePrompt } from "../consent/consent.js";
import { windowsHello, windowsPassphrasePrompt } from "../consent/consent-windows.js";
import { KEYRING_RESPONSES, type KeyringOp, type KeyringRequest, type KeyringResponse } from "../protocol.js";
import { realRunner, type Runner } from "../run.js";
import { serveKeyring } from "../server.js";
import { platformTypist } from "../typing/index.js";
import type { Typist } from "../typing/typist.js";
import { KEYRING_VERSION } from "../version.js";
import { ChallengeSchema, type DoorFile, DoorFileSchema, type HelperCall, HelperCallSchema, type HelperReply, type Proof } from "./door.js";
import { LineSocket } from "./lines.js";
import { hardenedPaths } from "./paths.js";
import { currentSid } from "./sid.js";

// `intentic-keyring session`: the hardened keyring's hands in this user's Windows session, started at sign-in. It does
// two things. It keeps the user's own pipe answering (intentic-machine, intentic-askpass and the CLI keep asking there)
// by carrying each request through the door to the service. And it is the service's way to a person and a keyboard: it
// proves itself with a Windows Hello signature (or the passphrase) once, then shows the service's prompts and does its
// typing. It holds no vault and no key; what it carries is one prompt's answer or one value being typed at a time.

const RETRY_MS = 5_000;
const REQUEST_DEADLINE_MS = 135_000;

const readDoor = async (path: string): Promise<DoorFile | undefined> => {
    try {
        const parsed = DoorFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): no door yet is the service not having started, which the caller waits out
        return undefined;
    }
};

// One request carried to the service and its answer back, parsed as the op's own (protocol.ts).
const throughDoor = async (door: DoorFile, request: KeyringRequest): Promise<KeyringResponse<KeyringOp>> => {
    const socket = connect({ host: "127.0.0.1", port: door.port });
    const lines = new LineSocket(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    lines.send({ door: door.token, as: "request" });
    lines.send(request);
    const answer = await lines.nextOf(KEYRING_RESPONSES[request.op], REQUEST_DEADLINE_MS);
    lines.end();
    return answer ?? { ok: false, code: "unavailable", refusal: "The hardened keyring did not answer: is its task running? (Task Scheduler, \\Intentic\\)" };
};

interface Hands {
    readonly hello: HelloDriver;
    readonly passphrase: PassphrasePrompt;
    readonly typist: Typist;
}

const answerCall = async (hands: Hands, call: HelperCall): Promise<HelperReply> => {
    switch (call.call) {
        case "sign": {
            const signed = await hands.hello.sign(call.credential, call.challenge, { title: call.title, message: call.message });
            return signed.ok ? { ok: true, signature: signed.value.toString("base64") } : { ok: false, cancelled: signed.cancelled, reason: signed.reason };
        }
        case "passphrase":
            return await hands.passphrase({ title: call.title, message: call.message });
        case "inspect":
            return await hands.typist.inspect(call.place);
        case "type":
            return await hands.typist.type(call.place, call.seen, call.value);
    }
};

// The helper's own connection: proven once, then answering the service's calls until it closes.
const holdTheLine = async (door: DoorFile, hands: Hands, log: (message: string) => void): Promise<void> => {
    const socket = connect({ host: "127.0.0.1", port: door.port });
    const lines = new LineSocket(socket);
    lines.send({ door: door.token, as: "helper" });
    const challenge = await lines.nextOf(ChallengeSchema, 30_000);
    if (challenge === undefined) {
        lines.end();
        return;
    }
    const notice = { title: "Connect the Intentic keyring", message: "The keyring on this computer asks you to confirm it is you, once for this sign-in, before it can ask you anything or type for you." };
    let proof: Proof;
    if (challenge.method === "hello") {
        const signed = await hands.hello.sign(challenge.credential, challenge.challenge, notice);
        proof = signed.ok ? { method: "hello", signature: signed.value.toString("base64") } : { method: "declined" };
    } else {
        const typed = await hands.passphrase(notice);
        proof = typed.kind === "answered" ? { method: "passphrase", passphrase: typed.passphrase } : { method: "declined" };
    }
    lines.send(proof);
    log(`proved this session with ${proof.method}`);
    for (;;) {
        const call = await lines.nextOf(HelperCallSchema, 24 * 60 * 60_000);
        if (call === undefined) {
            if (lines.closed) {
                return;
            }
            continue;
        }
        lines.send({ id: call.id, reply: await answerCall(hands, call) });
    }
};

export const runSession = async (runner: Runner = realRunner): Promise<void> => {
    const own = keyringPaths();
    const claim = await claimPidFile(own.pid, own.dir, { pid: process.pid, build: KEYRING_VERSION, supervisor: "session" });
    if (!claim.claimed) {
        throw new Error(`A keyring is running already (pid ${String(claim.holder.pid)}).`);
    }
    const sid = await currentSid(runner);
    const paths = hardenedPaths(sid);
    const log = (message: string): void => {
        process.stderr.write(`${new Date().toISOString()} session: ${message}\n`);
    };
    const hands: Hands = { hello: windowsHello(runner), passphrase: windowsPassphrasePrompt(runner), typist: platformTypist(runner) };
    await serveKeyring(
        {
            handle: async (request) => {
                const door = await readDoor(paths.door);
                return door === undefined ? { ok: false, code: "no-keyring", refusal: "The hardened keyring's service is not running yet." } : await throughDoor(door, request);
            },
        },
        own.address,
        log,
    );
    for (;;) {
        const door = await readDoor(paths.door);
        if (door !== undefined) {
            try {
                await holdTheLine(door, hands, log);
            } catch (error) {
                log(`lost the service: ${error instanceof Error ? error.message : "unknown error"}`);
            }
        }
        await sleep(RETRY_MS);
    }
};
