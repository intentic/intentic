import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import type { Rounds } from "../device/sandbox-rounds/ic-rounds.js";
import { startRounds } from "../device/sandbox-rounds/ic-rounds.js";
import { MACHINE_VERSION } from "../version.js";
import { readFleetConfig } from "./config.js";
import { createFleetContext, type FleetContext, keptPass } from "./context.js";
import { runJanitorPass, startJanitor } from "./janitor/janitor.js";
import { startKeeper } from "./keeper/fleet-keeper.js";
import { FLEET_RUN_DIR, FLEET_SOCKET } from "./paths.js";
import { type FleetAnswer, type FleetRequest, FleetRequestSchema, MAX_REQUEST_BYTES } from "./protocol.js";
import { runPrunePass, startPrune } from "./prune/prune.js";
import { registerRunner, removeRunner } from "./register.js";
import { startSlots } from "./slots/slots.js";
import { answered, type FleetSys, machineSys } from "./sys.js";
import { createUpdater, type Updater } from "./update.js";
import { DRAIN_LOOK_MS, drainLook, runnerLogs, runnerOp } from "./units.js";

/* THE CI FLEET SERVICE, `intentic-machine ci-fleet serve` as root under intentic-ci-fleet.service: the rounds that keep
   this computer's runners (the keeper, the drains, the janitor, the host prune, the slot holder) and the socket the
   person's agent asks over. One process, so the host runs one root daemon for its fleet where it ran two timers and a
   slot-holding service. A round that throws costs that round alone (startRounds); a request that throws answers
   `ok: false` with the reason. */

// How long one request may take to arrive whole: the agent writes its line at once.
const REQUEST_ARRIVAL_MS = 10_000;

const answerRequest = async (context: FleetContext, updater: Updater, request: FleetRequest): Promise<FleetAnswer> => {
    switch (request.verb) {
        case "status":
            return { ok: true, status: context.status.read() };
        case "hello":
            updater.heard(request.version);
            return { ok: true, status: context.status.read() };
        case "unit":
            return { ok: true, said: await runnerOp(context, request.name, request.op) };
        case "logs":
            return { ok: true, text: await runnerLogs(context, request.name, request.tail) };
        case "janitor": {
            const release = context.busy.hold();
            try {
                const pass = await runJanitorPass(context, { dryRun: request.dryRun });
                return { ok: true, pass: keptPass(pass) };
            } finally {
                release();
            }
        }
        case "prune": {
            const release = context.busy.hold();
            try {
                return { ok: true, pass: keptPass(await runPrunePass(context, { dryRun: request.dryRun })) };
            } finally {
                release();
            }
        }
        case "register":
            return { ok: true, said: await registerRunner(context, request.args) };
        case "deregister":
            return { ok: true, said: await removeRunner(context, request.args) };
    }
};

// One connection: a line in, an answer out, closed. A line too long, late or unreadable is refused unread.
const serveConnection = (context: FleetContext, updater: Updater, socket: Socket): void => {
    let buffered = "";
    let done = false;
    const reply = (answer: FleetAnswer): void => {
        if (!done) {
            done = true;
            socket.end(`${JSON.stringify(answer)}\n`);
        }
    };
    const timer = setTimeout(() => reply({ ok: false, error: "the request did not arrive whole in time" }), REQUEST_ARRIVAL_MS);
    socket.on("error", () => clearTimeout(timer));
    socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        if (buffered.length > MAX_REQUEST_BYTES) {
            clearTimeout(timer);
            reply({ ok: false, error: "the request is too long" });
            return;
        }
        const end = buffered.indexOf("\n");
        if (end === -1 || done) {
            return;
        }
        clearTimeout(timer);
        let raw: unknown;
        try {
            raw = JSON.parse(buffered.slice(0, end));
        } catch {
            reply({ ok: false, error: "the request is not JSON" });
            return;
        }
        const parsed = FleetRequestSchema.safeParse(raw);
        if (!parsed.success) {
            reply({ ok: false, error: `the service does not take that request: ${parsed.error.issues[0]?.message ?? "unreadable"}` });
            return;
        }
        answerRequest(context, updater, parsed.data).then(reply, (error: Error) => reply({ ok: false, error: errorMessage(error) }));
    });
};

// The socket, root's and the agent user's group's (0660), in a folder anyone may pass through.
export const listenOn = async (context: FleetContext, updater: Updater, path: string, gid: number): Promise<Server> => {
    await rm(path, { force: true });
    const server = createServer((socket) => serveConnection(context, updater, socket));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            resolve();
        });
    });
    await chown(path, 0, gid);
    await chmod(path, 0o660);
    return server;
};

const groupOf = async (sys: FleetSys, user: string): Promise<number> => {
    const gid = Number(answered(`id -g ${user}`, await sys.run("id", ["-g", user], { timeoutMs: 10_000 })).trim());
    if (!Number.isInteger(gid)) {
        throw new Error(`could not read the group of ${user}`);
    }
    return gid;
};

/** The service's whole life: until systemd stops it, or an update replaced its binary. */
export const serveFleet = async (log: Log): Promise<void> => {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
        throw new Error("`ci-fleet serve` is the root service intentic-ci-fleet.service runs on Linux; `sudo intentic-machine ci-fleet install --user <you>` sets it up.");
    }
    const config = await readFleetConfig();
    const context = await createFleetContext(config, machineSys, log, MACHINE_VERSION);
    await mkdir(FLEET_RUN_DIR, { recursive: true, mode: 0o755 });
    let server: Server | undefined;
    const rounds: Rounds[] = [];
    const stopped = new Promise<void>((resolve) => {
        const stop = (): void => {
            for (const round of rounds) {
                round.stop();
            }
            server?.close();
            resolve();
        };
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        const updater = createUpdater(context, MACHINE_VERSION, stop);
        void (async () => {
            server = await listenOn(context, updater, FLEET_SOCKET, await groupOf(machineSys, config.user));
        })().catch((error: Error) => {
            log(`ci-fleet: could not open ${FLEET_SOCKET}: ${errorMessage(error)}`);
            stop();
        });
    });
    rounds.push(
        startRounds("drains", log, DRAIN_LOOK_MS, () => DRAIN_LOOK_MS, async () => await drainLook(context)),
        startKeeper(context),
        startJanitor(context),
        startPrune(context),
        startSlots(context),
    );
    log(`ci-fleet: v${MACHINE_VERSION} serving ${FLEET_SOCKET} for ${config.user}`);
    await stopped;
    log("ci-fleet: stopped");
};
