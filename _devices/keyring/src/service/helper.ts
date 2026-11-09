import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { sleep } from "@intentic/base/async";
import { z } from "zod";
import { claimPidFile } from "@intentic/local-agent";
import { keyringPaths } from "../address.js";
import { type ChoicePrompt, type HelloDriver, type PassphrasePrompt, type ValuePrompt, WRONG_PROOF } from "../consent/consent.js";
import { KEYRING_RESPONSES, type KeyringOp, type KeyringRequest, type KeyringResponse } from "../protocol.js";
import { realRunner, type Runner } from "../run.js";
import { serveKeyring } from "../server.js";
import type { Typist } from "../typing/typist.js";
import { KEYRING_VERSION } from "../version.js";
import { type AppsWatch, appsWatchFor } from "../watch/apps.js";
import { type Challenge, ChallengeSchema, type DoorFile, DoorFileSchema, type HelperCall, HelperCallSchema, type HelperReply, type Proof } from "./door.js";
import { LineSocket } from "./lines.js";
import { asRecoveryKey } from "./recovery.js";
import { neededPerson, ProofGate, proofAsked } from "./proof-gate.js";
import { asksOf, EITHER_HINT } from "./remote.js";

// `intentic-keyring session`: the protected keyring's hands in this user's session, started at sign-in. It does two
// things. It keeps the user's own pipe answering (intentic-machine, intentic-askpass and the CLI keep asking there) by
// carrying each request through the door to the service. And it is the service's way to a person and a keyboard: it
// proves a person is at this session once (Windows Hello, a polkit yes, or the recovery key, asked again at once with
// what went wrong when the key did not open the vault; after a no, asked again only when something needs a person or
// the service restarted, proof-gate.ts), then shows the service's prompts and type-once box and does its
// typing. It holds no vault and no key; what it carries is one prompt's answer or one value being typed at a time.
// While the person lets Passwords remember what they type in programs, it also runs the focus watcher that offers the "Fill with Intentic" chip (watch/).

const RETRY_MS = 5_000;
// How many recovery keys the sign-in proof takes in a row before it waits for the next need, as the service's own
// prompt does (consent.ts PASSPHRASE_TRIES).
const PROOF_TRIES = 3;
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
            return await hands.passphrase({ title: call.title, message: call.message, asks: asksOf(call.message) });
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
    title: "Confirm it's you",
    message: "Once per sign-in, so Passwords can ask you things and type for you.",
};

/** What the helper answers a challenge with: `problem` says what went wrong with the last recovery key. Exported for its test. */
export const proofFor = async (challenge: Challenge, hands: Hands, { pid = process.pid, problem }: { readonly pid?: number; readonly problem?: string | undefined } = {}): Promise<Proof> => {
    switch (challenge.method) {
        case "hello": {
            const signed = await hands.hello?.sign(challenge.credential, challenge.challenge, PROOF_NOTICE);
            return signed?.ok === true ? { method: "hello", signature: signed.value.toString("base64") } : { method: "declined" };
        }
        case "polkit":
            // The service asks polkit about this process, which shows its own dialog in this session: nothing to type here.
            return { method: "polkit", pid };
        case "passphrase": {
            // The challenge does not say whether this vault has a master password (a field there would turn away a helper
            // a release behind), so the box asks for either.
            const typed = await hands.passphrase({ title: PROOF_NOTICE.title, message: `${PROOF_NOTICE.message}\n\n${EITHER_HINT}`, problem, asks: "either" });
            return typed.kind === "answered" ? { method: "passphrase", passphrase: asRecoveryKey(typed.passphrase) } : { method: "declined" };
        }
        case "unset":
            return { method: "unset" };
    }
};

// The service's word on a proof (channel.ts welcomeHelper): `ok` lets the helper in.
const VerdictSchema = z.object({ ok: z.boolean() });
const VERDICT_DEADLINE_MS = 30_000;

// How one connection to the service ended: lost (`gone`, tried again shortly), turned down by the person or refused
// (`declined`), a recovery key that did not open the vault (`wrong-key`, asked again at once), or a quiet look that
// found the service wants a person (`passed-over`). The last three wait for a need before asking again (proof-gate.ts).
type LineOutcome = "gone" | "declined" | "wrong-key" | "passed-over";

// How the helper answers this connection's challenge: `quiet` (after a restart, nobody asked for it) proves only where
// nothing needs a person, and `problem` is what went wrong with the last recovery key.
interface Look {
    readonly quiet: boolean;
    readonly problem?: string | undefined;
}

// The helper's own connection: proven once, then answering the service's calls until it closes.
const holdTheLine = async (door: DoorFile, hands: Hands, gate: ProofGate, log: (message: string) => void, asked: (method: Challenge["method"]) => void, look: Look): Promise<LineOutcome> => {
    const lines = new LineSocket(dial(door));
    lines.send({ door: door.token, as: "helper" });
    const challenge = await lines.nextOf(ChallengeSchema, 30_000);
    if (challenge === undefined) {
        lines.end();
        return "gone";
    }
    asked(challenge.method);
    if (look.quiet && challenge.method !== "unset") {
        // Only a service with no vault yet asks nothing of the person; anything else waits for a need, as before.
        lines.send({ method: "declined" });
        lines.end();
        return "passed-over";
    }
    const proof = await proofFor(challenge, hands, { problem: look.problem });
    lines.send(proof);
    const verdict = await lines.nextOf(VerdictSchema, VERDICT_DEADLINE_MS);
    if (verdict === undefined) {
        lines.end();
        log("the service did not answer this session's proof");
        return "gone";
    }
    if (!verdict.ok) {
        lines.end();
        if (proof.method === "declined") {
            log("the person did not prove this session");
            return "declined";
        }
        log(`the service refused this session's ${proof.method} proof`);
        return proof.method === "passphrase" ? "wrong-key" : "declined";
    }
    gate.settle(true);
    log(`proved this session with ${proof.method}`);
    try {
        for (;;) {
            const call = await lines.nextOf(HelperCallSchema, 24 * 60 * 60_000);
            if (call === undefined) {
                if (lines.closed) {
                    return "gone";
                }
                continue;
            }
            lines.send({ id: call.id, reply: await answerCall(hands, call) });
        }
    } finally {
        gate.settle(false);
    }
};

// While the helper waits for a need: says `changed` once the door file names a different service than `token`'s (a
// reset or an update restarted it), whose first question may need nobody.
const watchDoor = (path: string, token: string | undefined, changed: () => void, everyMs: number) => {
    const watching = new AbortController();
    void (async () => {
        while (!watching.signal.aborted) {
            await sleep(everyMs);
            const now = watching.signal.aborted ? undefined : await readDoor(path);
            if (!watching.signal.aborted && now !== undefined && now.token !== token) {
                changed();
                return;
            }
        }
    })();
    return watching;
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

export interface Proving {
    readonly doorFile: string;
    readonly hands: Hands;
    readonly gate: ProofGate;
    readonly log: (message: string) => void;
    // What the service asked this session for, so a refusal can tell the person where to look (proofAsked).
    readonly asked: (method: Challenge["method"]) => void;
    readonly retryMs?: number;
    // Stops it, for a test; a session's runs until the process ends.
    readonly signal?: AbortSignal;
}

// One connection to the service behind the door file, its challenge answered as `look` says.
const tryDoor = async ({ doorFile, hands, gate, log, asked }: Proving, look: Look): Promise<{ readonly outcome: LineOutcome; readonly token: string | undefined }> => {
    const door = await readDoor(doorFile);
    if (door === undefined) {
        return { outcome: "gone", token: undefined };
    }
    try {
        return { outcome: await holdTheLine(door, hands, gate, log, asked, look), token: door.token };
    } catch (error) {
        log(`lost the service: ${error instanceof Error ? error.message : "unknown error"}`);
        return { outcome: "gone", token: door.token };
    }
};

// After a no: waits for a need, or for the door to name a new service (`token` is the one it named), and says how to
// answer next. Undefined once `signal` stopped it.
const waitForNeed = async ({ doorFile, gate, log, retryMs = RETRY_MS, signal }: Proving, token: string | undefined): Promise<Look | undefined> => {
    const watching = watchDoor(doorFile, token, () => gate.restarted(), retryMs);
    const stop = (): void => gate.restarted();
    signal?.addEventListener("abort", stop, { once: true });
    const why = await gate.whenWanted();
    signal?.removeEventListener("abort", stop);
    watching.abort();
    if (signal?.aborted === true) {
        return undefined;
    }
    if (why === "restarted") {
        log("the service restarted: looking at what it asks, asking nobody");
    }
    return { quiet: why === "restarted" };
};

/** The helper's side of the door for as long as the session lasts: proven, serving, and proven again. Exported for its test. */
export const keepProving = async (proving: Proving): Promise<void> => {
    const stopped = (): boolean => proving.signal?.aborted === true;
    let look: Look | undefined = { quiet: false };
    let wrongKeys = 0;
    while (look !== undefined && !stopped()) {
        const { outcome, token } = await tryDoor(proving, look);
        wrongKeys = outcome === "wrong-key" ? wrongKeys + 1 : 0;
        if (outcome === "wrong-key" && wrongKeys < PROOF_TRIES) {
            // A key that did not open the vault is asked for again at once, saying so, rather than the box just closing.
            look = { quiet: false, problem: WRONG_PROOF };
        } else if (outcome === "gone") {
            await sleep(proving.retryMs ?? RETRY_MS);
            look = { quiet: false };
        } else {
            wrongKeys = 0;
            proving.log(outcome === "passed-over" ? "the service wants a person: not asking until something needs one" : "not asking again until something needs a person here");
            look = await waitForNeed(proving, token);
        }
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
    const gate = new ProofGate();
    let method: Challenge["method"] | undefined;
    await serveKeyring(
        {
            handle: async (request) => {
                const door = await readDoor(platform.doorFile);
                if (door === undefined) {
                    return { ok: false, code: "no-keyring", refusal: platform.noService };
                }
                const answer = await throughDoor(door, request);
                if (gate.proven || !neededPerson(answer)) {
                    return answer;
                }
                // Nobody here to ask, because the person turned the sign-in proof down: ask for it again now, and say where.
                log(`${request.op} needed a person: asking this session to prove itself again`);
                gate.want();
                return { ...answer, refusal: proofAsked(method) };
            },
        },
        own.address,
        log,
    );
    void keepAppsWatch(ask, appsWatchFor(runner, ask, log));
    await keepProving({
        doorFile: platform.doorFile,
        hands: platform.hands,
        gate,
        log,
        asked: (asked) => {
            method = asked;
        },
    });
};
