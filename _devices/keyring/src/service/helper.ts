import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { sleep } from "@intentic/base/async";
import { claimPidFile } from "@intentic/local-agent";
import { keyringPaths } from "../address.js";
import type { ChoicePrompt, HelloDriver, PassphrasePrompt, ValuePrompt } from "../consent/consent.js";
import { KEYRING_RESPONSES, type KeyringOp, type KeyringRequest, type KeyringResponse } from "../protocol.js";
import { realRunner, type Runner } from "../run.js";
import { serveKeyring } from "../server.js";
import type { Typist } from "../typing/typist.js";
import { KEYRING_VERSION } from "../version.js";
import { type AppsWatch, appsWatchFor } from "../watch/apps.js";
import { type Challenge, ChallengeSchema, type DoorFile, DoorFileSchema, type HelperCall, HelperCallSchema, type HelperReply, type Proof } from "./door.js";
import { LineSocket } from "./lines.js";
import { asRecoveryKey } from "./recovery.js";
import { RECOVERY_HINT } from "./remote.js";

// `intentic-keyring session`: the protected keyring's hands in this user's session, started at sign-in. It does two
// things. It keeps the user's own pipe answering (intentic-machine, intentic-askpass and the CLI keep asking there) by
// carrying each request through the door to the service. And it is the service's way to a person and a keyboard: it
// proves a person is at this session once (Windows Hello, a polkit yes, or the recovery key), then shows the service's
// prompts and type-once box and does its typing. It holds no vault and no key; what it carries is one prompt's answer
// or one value being typed at a time. While the person lets Passwords remember what they type in programs, it also
// runs the focus watcher that offers the "Fill with Intentic" chip (watch/).

const RETRY_MS = 5_000;
const REQUEST_DEADLINE_MS = 135_000;
// How often the helper reads whether remembering from programs is on, to start or stop the chip's watcher.
const REMEMBER_POLL_MS = 60_000;

// What differs between Windows and Linux (session-windows.ts, session-linux.ts).
export interface SessionPlatform {
    // The door file the service writes.
    readonly doorFile: string;
    readonly hands: Hands;
    // Why nothing answers when there is no door yet.
    readonly noService: string;
}

export interface Hands {
    // Windows Hello, where this session has it.
    readonly hello: HelloDriver | undefined;
    readonly passphrase: PassphrasePrompt;
    // The type-once box, where this session can show one.
    readonly value: ValuePrompt | undefined;
    // The choice dialog (an agent's need), where this session can show one.
    readonly choose: ChoicePrompt | undefined;
    readonly typist: Typist;
}

const readDoor = async (path: string): Promise<DoorFile | undefined> => {
    try {
        const parsed = DoorFileSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): no door yet is the service not having started, which the caller waits out
        return undefined;
    }
};

const dial = (door: DoorFile): Socket => ("port" in door ? connect({ host: "127.0.0.1", port: door.port }) : connect(door.socket));

// One request carried to the service and its answer back, parsed as the op's own (protocol.ts).
const throughDoor = async (door: DoorFile, request: KeyringRequest): Promise<KeyringResponse<KeyringOp>> => {
    const socket = dial(door);
    const lines = new LineSocket(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    lines.send({ door: door.token, as: "request" });
    lines.send(request);
    const answer = await lines.nextOf(KEYRING_RESPONSES[request.op], REQUEST_DEADLINE_MS);
    lines.end();
    return answer ?? { ok: false, code: "unavailable", refusal: "Passwords' service did not answer: is it running?" };
};

const UNAVAILABLE_HELLO = { ok: false, cancelled: false, reason: "Windows Hello is not on this computer" } as const;

export const answerCall = async (hands: Hands, call: HelperCall): Promise<HelperReply> => {
    switch (call.call) {
        case "sign": {
            const signed = (await hands.hello?.sign(call.credential, call.challenge, { title: call.title, message: call.message })) ?? UNAVAILABLE_HELLO;
            return signed.ok ? { ok: true, signature: signed.value.toString("base64") } : { ok: false, cancelled: signed.cancelled, reason: signed.reason };
        }
        case "hello-available":
            return { available: (await hands.hello?.available()) === true };
        case "enrol": {
            const made = (await hands.hello?.enrol(call.credential, call.challenge, { title: call.title, message: call.message })) ?? UNAVAILABLE_HELLO;
            return made.ok ? { ok: true, signature: made.value.signature.toString("base64"), publicKey: made.value.publicKey } : { ok: false, cancelled: made.cancelled, reason: made.reason };
        }
        case "passphrase":
            return await hands.passphrase({ title: call.title, message: call.message });
        case "value":
            return hands.value === undefined
                ? { kind: "unavailable", reason: "this session cannot show Passwords' own box" }
                : await hands.value({ title: call.title, message: call.message, remember: call.remember, username: call.username });
        case "choice":
            return hands.choose === undefined ? { kind: "unavailable", reason: "this session cannot show Passwords' choice" } : await hands.choose({ title: call.title, message: call.message, choices: call.choices });
        case "inspect":
            return await hands.typist.inspect(call.place);
        case "type":
            return await hands.typist.type(call.place, call.seen, call.value);
    }
};

const PROOF_NOTICE = {
    title: "Connect Passwords",
    message: "Passwords on this computer asks you to confirm it is you, once for this sign-in, before it can ask you anything or type for you.",
};

/** What the helper answers a challenge with. Exported for its test. */
export const proofFor = async (challenge: Challenge, hands: Hands, pid: number = process.pid): Promise<Proof> => {
    switch (challenge.method) {
        case "hello": {
            const signed = await hands.hello?.sign(challenge.credential, challenge.challenge, PROOF_NOTICE);
            return signed?.ok === true ? { method: "hello", signature: signed.value.toString("base64") } : { method: "declined" };
        }
        case "polkit":
            // The service asks polkit about this process, which shows its own dialog in this session: nothing to type here.
            return { method: "polkit", pid };
        case "passphrase": {
            const typed = await hands.passphrase({ title: PROOF_NOTICE.title, message: `${PROOF_NOTICE.message}\n\n${RECOVERY_HINT}` });
            return typed.kind === "answered" ? { method: "passphrase", passphrase: asRecoveryKey(typed.passphrase) } : { method: "declined" };
        }
        case "unset":
            return { method: "unset" };
    }
};

// The helper's own connection: proven once, then answering the service's calls until it closes.
const holdTheLine = async (door: DoorFile, hands: Hands, log: (message: string) => void): Promise<void> => {
    const lines = new LineSocket(dial(door));
    lines.send({ door: door.token, as: "helper" });
    const challenge = await lines.nextOf(ChallengeSchema, 30_000);
    if (challenge === undefined) {
        lines.end();
        return;
    }
    const proof = await proofFor(challenge, hands);
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

// The chip's watcher, on while the vault says the person lets Passwords remember what they type in programs.
const keepAppsWatch = async (ask: (request: KeyringRequest) => Promise<KeyringResponse<KeyringOp> | undefined>, watch: AppsWatch | undefined): Promise<never> => {
    for (;;) {
        const state = await ask({ op: "state" });
        const on = state !== undefined && state.ok && "state" in state && state.state.remember?.apps === true;
        if (on) {
            watch?.start();
        } else {
            watch?.stop();
        }
        await sleep(REMEMBER_POLL_MS);
    }
};

export const runSession = async (platformOf: (runner: Runner) => Promise<SessionPlatform>, runner: Runner = realRunner): Promise<void> => {
    const own = keyringPaths();
    const claim = await claimPidFile(own.pid, own.dir, { pid: process.pid, build: KEYRING_VERSION, supervisor: "session" });
    if (!claim.claimed) {
        throw new Error(`A keyring is running already (pid ${String(claim.holder.pid)}).`);
    }
    const platform = await platformOf(runner);
    const log = (message: string): void => {
        process.stderr.write(`${new Date().toISOString()} session: ${message}\n`);
    };
    const ask = async (request: KeyringRequest): Promise<KeyringResponse<KeyringOp> | undefined> => {
        const door = await readDoor(platform.doorFile);
        // allow(silent-catch): a service that does not answer is no answer, which the watcher reads as off until next time
        return door === undefined ? undefined : await throughDoor(door, request).catch(() => undefined);
    };
    await serveKeyring(
        {
            handle: async (request) => {
                const door = await readDoor(platform.doorFile);
                return door === undefined ? { ok: false, code: "no-keyring", refusal: platform.noService } : await throughDoor(door, request);
            },
        },
        own.address,
        log,
    );
    void keepAppsWatch(ask, appsWatchFor(runner, ask, log));
    for (;;) {
        const door = await readDoor(platform.doorFile);
        if (door !== undefined) {
            try {
                await holdTheLine(door, platform.hands, log);
            } catch (error) {
                log(`lost the service: ${error instanceof Error ? error.message : "unknown error"}`);
            }
        }
        await sleep(RETRY_MS);
    }
};
