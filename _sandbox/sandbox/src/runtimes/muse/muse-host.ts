import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { checkServedFingerprint, Connection, type DuplexTransport, MspError } from "@muse-code/sdk";
import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { namespaceTargetOf, type NamespaceEntryReference, nsenterArgv } from "../../workload/namespace-entry.js";
import { spawnAs } from "../../workload/workload-class.js";
import type { z } from "zod";
import { outputTail } from "../stdio/child-output.js";
import { InitializeAnswerSchema, type MuseNotification, type MuseParams } from "./muse-wire.js";

// One `muse serve` process speaking the Muse Session Protocol over its stdio, and the little of it the loop reads. The
// SDK's `Connection` does the framing, the command ids and the typed errors; the process itself is spawned here rather
// than by the SDK's own spawner, because a turn's host has to be born inside the turn's mount namespace (nsenter) and
// ranked for the OOM killer like every other agent runtime (spawnAs), and the SDK's spawner takes neither.

// Where the host is born: the pid holding the turn's mount namespace, and the workspace root as it sees it. Absent
// means spawned plainly.
export interface MuseNamespace {
    readonly pid: number;
    readonly cwd: string;
    readonly namespace?: NamespaceEntryReference;
}

export interface MuseLaunch {
    readonly binary: string;
    // Everything after `serve`.
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly namespace?: MuseNamespace;
    readonly spawnDepth?: number;
}

export interface MuseHost {
    // The version the host says it is, from its handshake.
    readonly version: string;
    // A query: no command id, no durable record (model/list, permissionProfile/list).
    // Each answer is parsed against the schema the caller names for the method it asked (muse-wire.ts).
    readonly request: <S extends z.ZodType>(method: string, params: MuseParams, answer: S) => Promise<z.infer<S>>;
    // A command: the connection mints its idempotency id (session/start, turn/start, approval/decide).
    readonly command: <S extends z.ZodType>(method: string, params: MuseParams, answer: S) => Promise<z.infer<S>>;
    // Every notification from now on, in arrival order; returns the unsubscribe.
    readonly listen: (listener: (notification: MuseNotification) => void) => () => void;
    // Settles once the process is gone: undefined after our own close, else the sentence saying how it ended.
    readonly exited: Promise<string | undefined>;
    readonly close: () => Promise<void>;
}

export type MuseHostOpener = (launch: MuseLaunch) => Promise<MuseHost>;

// Whatever a command threw, as errorMessage reads it.
type Thrown = Parameters<typeof errorMessage>[0];

// The protocol's own name for a failure, read before any sentence: `sessionNotFound`, `overloaded`, `commandRejected`.
export const mspErrorKind = (error: Thrown): string | undefined => (error instanceof MspError ? error.kind : undefined);

// What the client tells the host about itself and asks of it. `sessionMcp` lets a session carry the turn's MCP servers;
// the experimental surface carries `session/setPermissionProfile`, which moves a planning session back out of read-only.
export const MUSE_CLIENT = {
    clientInfo: { name: "intentic", version: "1" },
    capabilities: { experimentalApi: true, requestedCapabilities: ["sessionMcp"], userInputDialogs: true },
} as const;

// How long a host may take to drain after its input closes before it is stopped; Muse's own drain window is 30 s, but a
// turn that is over has nothing left worth waiting that long for.
const CLOSE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;

type MuseSpawn = (command: string, args: readonly string[], env: Readonly<Record<string, string>>, spawnDepth: number) => ChildProcessWithoutNullStreams;

const spawnMuse: MuseSpawn = (command, args, env, spawnDepth) =>
    spawnAs({ class: "agentRuntime", spawnDepth }, command, args, { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });

// The child's stdio as the SDK's transport: decoded text in, frames out, and the end of its input as the close.
const stdioTransport = (child: ChildProcessWithoutNullStreams): DuplexTransport => {
    child.stdout.setEncoding("utf8");
    return {
        incoming: {
            async *[Symbol.asyncIterator]() {
                for await (const chunk of child.stdout) {
                    yield String(chunk);
                }
            },
        },
        write: (chunk) =>
            new Promise<void>((resolve, reject) => {
                child.stdin.write(chunk, (error) => (error === null || error === undefined ? resolve() : reject(error)));
            }),
        close: () => {
            child.stdin.end();
        },
    };
};

export const spawnMuseHost =
    (spawnProcess: MuseSpawn = spawnMuse): MuseHostOpener =>
    async (launch) => {
        const args = ["serve", ...launch.args];
        // nsenter execs the host into the turn's anchor, staying a direct child; its cwd is the workspace as the turn sees it.
        const argv =
            launch.namespace === undefined
                ? { command: launch.binary, args }
                : nsenterArgv(namespaceTargetOf(launch.namespace), launch.namespace.cwd, launch.binary, args);
        const child = spawnProcess(argv.command, argv.args, launch.env, launch.spawnDepth ?? 0);
        const stderr = outputTail(4_096);
        stderr.follow(child.stderr);
        let closing = false;
        const exited = new Promise<string | undefined>((resolve) => {
            child.once("error", (error) => {
                stderr.append(error.message);
                resolve(`Muse Code could not be started: ${error.message}`);
            });
            child.once("exit", (code, signal) => {
                const detail = stderr.text().trim();
                resolve(closing ? undefined : `Muse Code exited (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`);
            });
        });
        const connection = new Connection(stdioTransport(child));
        const listeners = new Set<(notification: MuseNotification) => void>();
        connection.onNotification((notification) => {
            for (const listener of listeners) {
                listener(notification);
            }
        });
        // The presentation receipt: the decision itself travels as a command (approval/decide, userInput/answer).
        connection.onServerRequest(async () => ({}));
        const close = async (): Promise<void> => {
            if (closing) {
                return;
            }
            closing = true;
            // allow(silent-catch): a connection already broken has nothing to flush; the exit wait and kill below still run.
            await connection.close().catch(() => undefined);
            const gone = await Promise.race([exited.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)]);
            if (!gone) {
                child.kill("SIGTERM");
                const stopped = await Promise.race([exited.then(() => true), sleep(KILL_GRACE_MS).then(() => false)]);
                if (!stopped) {
                    child.kill("SIGKILL");
                }
            }
        };
        try {
            const answer = InitializeAnswerSchema.parse(
                await Promise.race([
                    connection.request("initialize", { ...MUSE_CLIENT }),
                    exited.then((reason) => {
                        throw new Error(reason ?? "Muse Code exited before it answered");
                    }),
                ]),
            );
            // A host built from another protocol revision still serves this one's stable surface; the pinned SDK and the
            // blessed binary move together, so a mismatch is a skew worth keeping beside the stderr, not a refusal.
            if (checkServedFingerprint(answer.schema.fingerprint) !== undefined) {
                stderr.append(`\n[intentic] Muse Code served schema ${answer.schema.fingerprint}, not the one @muse-code/sdk was built against`);
            }
            connection.notify("initialized");
            await connection.flush();
            return {
                version: answer.serverInfo.version,
                request: async (method, params, schema) => schema.parse(await connection.request(method, { ...params })),
                command: async (method, params, schema) => schema.parse(await connection.command(method, { ...params })),
                listen: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                exited,
                close,
            };
        } catch (error) {
            await close();
            const detail = stderr.text().trim();
            throw new Error(`${errorMessage(error)}${detail === "" ? "" : `: ${detail}`}`, { cause: error });
        }
    };

// The host every turn gets unless a suite hands in its own.
export const openMuseHost: MuseHostOpener = spawnMuseHost();

// Re-exported so the loop's tests can build typed protocol failures without importing the SDK themselves.
export { MspError };
