import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { runBounded } from "@intentic/base/process";
import type { Log } from "@intentic/local-agent";
import type { RemoteServiceAction, RemoteServiceResult } from "@intentic/sandbox-contract/schemas/device-remote";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { ELEVATED_TIMEOUT_MS, type ElevatedOutcome, elevatedRun, runAsAdministrator } from "../../admin/elevated.js";
import { MACHINE_VERSION } from "../../version.js";
import { audit } from "../audit.js";
import { runningBeforeSignIn } from "../session.js";
import { realRemotedIo, resolveRemoted } from "./remoted-binary.js";

/* THE LOCK SCREEN AND ADMINISTRATOR PROMPTS, FOR PEOPLE'S REMOTE ACCESS ON WINDOWS (2026-11-20). remoted runs in the
   person's session, which cannot see or drive Windows' secure desktop: the sign-in and lock screen, Ctrl+Alt+Del, UAC
   prompts. `intentic-remoted service install` puts a Windows service of remoted's own in place that can, serving the
   remoted binaries it was installed for (`--client`), and needs an administrator. This is the device procedure
   `remoteService` (schemas/device-remote.ts): `status` runs `intentic-remoted service status` as this agent;
   `install` runs remoted through ONE UAC prompt (elevated.ts, the one the keyring's service goes through), and then reads
   the status again unelevated; what the elevated run prints does not come back across the elevation, so it also writes
   its answer to a file (`--result`), read for the reason when it failed. `uninstall` first asks unelevated: remoted
   then asks the running service, through its helper, to remove itself (taking a privilege away needs nobody's yes, and
   the person may not be at the computer); only when that cannot be done (exit 3: no helper reachable from this session)
   does it go through the prompt. The client is the remoted this agent starts (remoted-binary.ts), fetched first if it
   is not there yet.

   Who may ask (2026-11-20): only the daemon, for a person with Full access to its sandbox (the editor's
   `remote.changeService`), as for the people switches themselves; never a tool, so no agent can put a UAC prompt in
   front of the person. The prompt is the person at this computer's own say on top of that, and no switch of the link
   gates it: the switches decide what people may do over remoted, and the service only lets that reach the secure desktop.
   An agent anywhere but Windows answers `supported: false` without running anything. */

// `service status` asks the service manager and answers at once; a cold binary on a busy laptop gets this long.
const STATUS_TIMEOUT_MS = 30_000;

const NOT_WINDOWS =
    "Only Windows keeps its lock screen and administrator prompts apart from the desktop people already reach, so there is nothing to set up on this computer.";
const NOBODY_SIGNED_IN =
    "Nobody has signed in on this PC since it started, so there is nobody to show Windows' administrator prompt to. Try again once someone has signed in.";

const VERSION = /^\d+\.\d+\.\d+$/u;

/** What remoted is run with for each action; `client` is the remoted the installed service serves, `result` the file an
 * elevated run writes its answer to. Pure. */
export const serviceArgs = (action: RemoteServiceAction, client: string, result?: string): string[] => {
    const args = action === "install" ? ["service", "install", "--client", client] : ["service", action];
    return result === undefined || action === "status" ? args : [...args, "--result", result];
};

// remoted's exit code for "needs an administrator": an unelevated uninstall that could not reach the service's helper.
const NEEDS_ADMINISTRATOR = 3;

// What `intentic-remoted service status` (and install, uninstall) end their stdout with, one JSON line. Read loosely:
// a field a newer remoted adds is left out, and a state it adds is passed on as it names it.
const HelperSchema = z.object({ session: z.int(), desktop: z.string().nullable() });
const ServiceLineSchema = z.union([
    z.object({ error: z.string() }),
    z.object({ supported: z.literal(false), reason: z.string().optional() }),
    z.object({ supported: z.literal(true), installed: z.literal(false) }),
    z.object({ supported: z.literal(true), installed: z.literal(true), state: z.string(), version: z.string(), helper: HelperSchema.nullable().optional() }),
]);
export type ServiceLine = z.infer<typeof ServiceLineSchema>;
type ServiceStatus = Exclude<ServiceLine, { readonly error: string }>;

/** The JSON line remoted ends its stdout with; undefined when its last line is not one. Pure. */
export const readServiceLine = (stdout: string): ServiceLine | undefined =>
    parseJsonWith(stdout.trimEnd().split(/\r?\n/u).at(-1)?.trim() ?? "", ServiceLineSchema);

/** The status as the agent answers it, judged against the agent's own remoted version (undefined: not known). Pure. */
export const answerOf = (line: ServiceStatus, agentVersion: string | undefined): RemoteServiceResult => {
    let answer: RemoteServiceResult;
    if (!line.supported) {
        answer = { supported: false, installed: false, outOfDate: false };
        if (line.reason !== undefined) {
            answer.reason = line.reason;
        }
    } else if (line.installed) {
        answer = {
            supported: true,
            installed: true,
            state: line.state,
            version: line.version,
            outOfDate: agentVersion !== undefined && line.version !== agentVersion,
            helper: line.helper ?? null,
        };
    } else {
        answer = { supported: true, installed: false, outOfDate: false };
    }
    if (agentVersion !== undefined) {
        answer.agentVersion = agentVersion;
    }
    return answer;
};

/** What an install's or an uninstall's prompt came to, as the answer's `declined` and `error`, given the status after. Pure. */
export const outcomeFields = (
    action: Exclude<RemoteServiceAction, "status">,
    outcome: ElevatedOutcome,
    after: Pick<RemoteServiceResult, "installed" | "outOfDate">,
): Pick<RemoteServiceResult, "declined" | "error"> => {
    const doing = action === "install" ? "Setting up the lock-screen service" : "Removing the lock-screen service";
    switch (outcome.kind) {
        case "done":
            if (action === "install" && (!after.installed || after.outOfDate)) {
                return { error: `${doing} finished, but the service is ${after.installed ? "still at its older version" : "not there"}.` };
            }
            return action === "uninstall" && after.installed ? { error: `${doing} finished, but the service is still there.` } : {};
        case "declined":
            return { declined: true };
        case "unstarted":
            return { error: `Windows' administrator prompt could not be shown (${outcome.why}).` };
        default:
            if (outcome.timedOut) {
                return { error: `Nobody answered Windows' administrator prompt within ${ELEVATED_TIMEOUT_MS / 60_000} minutes, so this stopped waiting.` };
            }
            return {
                error: `${doing} failed as administrator (intentic-remoted exited ${String(outcome.exitCode)})${outcome.said === "" ? "" : `: ${outcome.said}`}.`,
            };
    }
};

export interface RemotedServiceSeams {
    readonly platform: NodeJS.Platform;
    readonly beforeSignIn: () => boolean;
    // The remoted this agent starts, fetched first when it is not there (remoted-binary.ts), as an absolute path, which
    // the service is told to serve; throws saying why not.
    readonly binary: (log: Log) => Promise<string>;
    // `binary args` as this agent: its stdout, and its exit code (null: it did not run, or did not end).
    readonly run: (binary: string, args: readonly string[]) => Promise<{ readonly exitCode: number | null; readonly stdout: string }>;
    // `binary args` through one UAC prompt (elevated.ts).
    readonly elevated: (binary: string, args: readonly string[]) => Promise<ElevatedOutcome>;
    // A file an elevated run may write its answer to, and that answer read back (and the file removed); undefined when
    // there is none.
    readonly resultFile: () => string;
    readonly readResult: (path: string) => Promise<string | undefined>;
    readonly audit: (entry: { tool: string; ok: boolean; detail: string }) => Promise<void>;
}

// The link a call came in on: its sandbox, for the audit, and the log its lines go to.
export interface ServiceLink {
    readonly sandboxUrl: string;
    readonly log: Log;
}

export interface RemotedService {
    readonly run: (action: RemoteServiceAction, link: ServiceLink) => Promise<RemoteServiceResult>;
}

const hostOf = (sandboxUrl: string): string => URL.parse(sandboxUrl)?.host ?? sandboxUrl;

const binaryOf = async (seams: RemotedServiceSeams, log: Log): Promise<string> => {
    try {
        return await seams.binary(log);
    } catch (error) {
        throw new ORPCError("PRECONDITION_FAILED", { message: `Refused: there is no intentic-remoted on this computer to ask: ${errorMessage(error)}` });
    }
};

// The service's status, unelevated, with the version of the remoted an install would put in place.
const statusOf = async (seams: RemotedServiceSeams, binary: string): Promise<RemoteServiceResult> => {
    const [said, version] = await Promise.all([seams.run(binary, ["service", "status"]), seams.run(binary, ["version"])]);
    const line = readServiceLine(said.stdout);
    if (line === undefined || "error" in line) {
        const ran = said.exitCode === null ? "did not run" : `exited ${String(said.exitCode)}`;
        const why = line === undefined ? `it printed no status and ${ran}` : line.error;
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: `intentic-remoted on this computer could not say whether its service is set up: ${why}.` });
    }
    return answerOf(line, version.exitCode === 0 ? VERSION.exec(version.stdout.trim())?.[0] : undefined);
};

const outcomeWords = (result: RemoteServiceResult): string => {
    if (result.declined === true) {
        return "the administrator's yes was not given";
    }
    const now = result.installed ? `installed (${result.version ?? "?"}, ${result.state ?? "?"})` : "not installed";
    return result.error === undefined ? `done, now ${now}` : `${result.error} Now ${now}`;
};

// The reason an elevated run's own answer gives, put into a failure that has none of its own.
const withReason = (outcome: ElevatedOutcome, answer: string | undefined): ElevatedOutcome => {
    const line = answer === undefined ? undefined : readServiceLine(answer);
    return outcome.kind === "failed" && line !== undefined && "error" in line ? { ...outcome, said: line.error.replace(/\.$/u, "") } : outcome;
};

export const createRemotedService = (seams: RemotedServiceSeams): RemotedService => {
    // The change whose UAC prompt is up now: one at a time, so a second press never stacks a second prompt.
    let asking: RemoteServiceAction | undefined;
    const finish = (action: Exclude<RemoteServiceAction, "status">, link: ServiceLink, result: RemoteServiceResult): RemoteServiceResult => {
        const detail = `${hostOf(link.sandboxUrl)} asked to ${action} remoted's Windows service: ${outcomeWords(result)}`;
        void seams.audit({ tool: "remoteService", ok: result.declined !== true && result.error === undefined, detail });
        link.log(`${link.sandboxUrl}: ${detail}`);
        return result;
    };
    const change = async (action: Exclude<RemoteServiceAction, "status">, link: ServiceLink): Promise<RemoteServiceResult> => {
        if (asking !== undefined) {
            throw new ORPCError("CONFLICT", {
                message: `Windows is already asking for an administrator's yes on this computer to ${asking === "install" ? "set up" : "remove"} the lock-screen service. Answer that prompt first.`,
            });
        }
        asking = action;
        try {
            const binary = await binaryOf(seams, link.log);
            if (action === "uninstall") {
                const quiet = await seams.run(binary, serviceArgs("uninstall", binary));
                if (quiet.exitCode !== NEEDS_ADMINISTRATOR) {
                    const after = await statusOf(seams, binary);
                    return finish(action, link, { ...after, ...outcomeFields(action, quiet.exitCode === 0 ? { kind: "done" } : { kind: "failed", exitCode: quiet.exitCode, said: "", timedOut: false }, after) });
                }
            }
            if (seams.beforeSignIn()) {
                throw new ORPCError("CONFLICT", { message: NOBODY_SIGNED_IN });
            }
            link.log(`${link.sandboxUrl}: asking for an administrator's yes to ${action} remoted's Windows service (client ${binary})`);
            const resultFile = seams.resultFile();
            const outcome = withReason(await seams.elevated(binary, serviceArgs(action, binary, resultFile)), await seams.readResult(resultFile));
            const after = await statusOf(seams, binary);
            return finish(action, link, { ...after, ...outcomeFields(action, outcome, after) });
        } finally {
            asking = undefined;
        }
    };
    return {
        run: async (action, link) => {
            if (seams.platform !== "win32") {
                return { supported: false, reason: NOT_WINDOWS, installed: false, outOfDate: false };
            }
            return action === "status" ? await statusOf(seams, await binaryOf(seams, link.log)) : await change(action, link);
        },
    };
};

const realSeams = (): RemotedServiceSeams => ({
    platform: process.platform,
    beforeSignIn: runningBeforeSignIn,
    binary: async (log) => resolve(await resolveRemoted(MACHINE_VERSION, realRemotedIo(log))),
    run: async (binary, args) => {
        const result = await runBounded(binary, args, { timeoutMs: STATUS_TIMEOUT_MS });
        return { exitCode: result.spawnError === undefined ? result.exitCode : null, stdout: result.stdout.text };
    },
    elevated: async (binary, args) => await runAsAdministrator(elevatedRun(binary, args)),
    resultFile: () => join(tmpdir(), `intentic-remoted-service-${randomUUID()}.json`),
    readResult: async (path) => {
        try {
            return await readFile(path, "utf8");
        } catch {
            // allow(silent-catch): an elevated run that never started, or a remoted too old for --result, wrote nothing
            return undefined;
        } finally {
            await rm(path, { force: true });
        }
    },
    audit,
});

let machine: RemotedService | undefined;

// This agent's one way to remoted's Windows service, shared by every link, so one prompt is up at a time.
export const machineRemotedService = (): RemotedService => {
    machine ??= createRemotedService(realSeams());
    return machine;
};
