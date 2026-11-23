import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { MACHINE_VERSION } from "../../../version.js";
import { ScopeError } from "../../policy.js";
import { realRemotedIo, resolveRemoted } from "../../remote/remoted-binary.js";

/* RUN AS ADMINISTRATOR, WITH NO UAC PROMPT (2026-11-23). run_command's `admin` on Windows: the command line is the same
   PowerShell invocation an ordinary run makes, handed to `intentic-remoted service admin-run`, which asks the SYSTEM
   helper of remoted's Windows service (the "Lock screen and admin prompts" service, installed once with one
   administrator's yes) to start it with the signed-in person's own administrator token in their session: what clicking
   Yes on UAC gives (their profile, their HKCU, windows on their desktop), with stdout, stderr and the exit code coming
   back as an ordinary run's do. The CLI writes one JSON line to `--status` before it exits, saying whether the command
   ran, and why not when it did not; it is killed with the call's deadline, and the helper then ends the command and
   everything it started.

   The switches are this agent's to enforce (policy.ts): `shell`, then `admin`, on top of the destructive and
   sandbox-power checks every command answers to. The owner's yes for each run is the daemon's card
   (hosts/host-command-guard.ts), which only a conversation's auto-approve mark answers by itself.

   Rejected (2026-11-23): an agent clicking Yes on the UAC prompt through the screen (consent nobody gives, a fragile
   picture of a dimmed desktop, and no telling whose prompt it is), and Start-Process -Verb RunAs, which waits for
   somebody at the computer and hands no output back. */

/** What `intentic-remoted service admin-run` writes to its `--status` file. */
export const AdminRunStatusSchema = z.union([
    z.object({ ran: z.literal(true), exitCode: z.number() }),
    z.object({ ran: z.literal(false), reason: z.string(), error: z.string() }),
]);
export type AdminRunStatus = z.infer<typeof AdminRunStatusSchema>;

/**
 * The remoted arguments that run `program args` as administrator from `cwd` on the sandbox's `grant`, the answer written
 * to `status`. Pure. Without a grant the service refuses, and says so.
 */
export const adminRunArgs = (status: string, cwd: string, program: string, args: readonly string[], grant?: string): string[] => [
    "service",
    "admin-run",
    "--status",
    status,
    "--cwd",
    cwd,
    ...(grant === undefined ? [] : ["--grant", grant]),
    "--",
    program,
    ...args,
];

// Where the owner sets the service up, said the same way in each refusal that needs it.
const SET_UP_ONCE = `The owner does that once from this device's Remote access section in Intentic ("Lock screen and admin prompts"), with one Windows prompt answered at this computer.`;
// Said wherever the agent might reach for Windows' own prompt instead.
const NOT_RUNAS = `Raising Windows' own prompt instead (Start-Process -Verb RunAs) waits for someone at this computer to click it and hands no output back.`;

/** What the agent reads when the command did not run as administrator, by the reason remoted gave. Pure. */
export const adminRunFailure = (status: Extract<AdminRunStatus, { ran: false }>): string => {
    switch (status.reason) {
        case "not-installed":
            return `Not run: running as administrator here goes through Intentic's lock screen and admin prompts service, which is not set up on this computer. ${SET_UP_ONCE} ${NOT_RUNAS}`;
        case "outdated":
            return `Not run: the lock screen and admin prompts service on this computer is older than administrator runs, so it must be set up again. ${SET_UP_ONCE}`;
        case "not-running":
            return `Not run: the lock screen and admin prompts service is installed on this computer, but its helper is not running in this session (${status.error}). Ask the owner to check it in this device's Remote access section.`;
        case "nobody-signed-in":
            return `Not run: nobody is signed in on this computer's screen, and an administrator run uses the signed-in person's own administrator rights.`;
        case "not-administrator":
            return `Not run: the account signed in on this computer is not an administrator, so there are no administrator rights to run it with.`;
        case "not-windows":
            return `Not run: running as administrator is for Windows computers only.`;
        case "untrusted":
            return `Not run: the lock screen and admin prompts service on this computer was set up before administrator runs were signed, or from another sandbox, so it does not know this sandbox's key. ${SET_UP_ONCE}`;
        case "refused":
            return `Not run: the service on this computer refused it (${status.error}). Do not retry it with a different spelling; tell the owner.`;
        default:
            return `Not run as administrator: ${status.error}`;
    }
};

// Refusals that need no remoted: what this agent knows before asking.
export const ADMIN_NOT_WINDOWS =
    "Refused: `admin` runs a command as Windows' administrator, and this computer is not running Windows. On Linux a command that needs root still needs someone to type a password, which nobody can do here.";
export const ADMIN_NOT_CROSSING =
    'Refused: `admin` runs on the Windows side of this PC only, not with `in`. Inside a WSL distro, root needs no administrator: run `wsl -d <distro> -u root -- <command>` from the Windows side, without `admin`.';

export interface AdminRunSeams {
    // The remoted this agent starts, fetched first when it is not there; throws saying why not.
    readonly binary: () => Promise<string>;
    readonly statusFile: () => string;
    // The status file's answer, and the file removed; undefined when nothing was written (killed, or a remoted too old).
    readonly readStatus: (path: string) => Promise<AdminRunStatus | undefined>;
}

export const realAdminRunSeams = (log: (message: string) => void): AdminRunSeams => ({
    binary: async () => resolve(await resolveRemoted(MACHINE_VERSION, realRemotedIo(log))),
    statusFile: () => join(tmpdir(), `intentic-admin-run-${randomUUID()}.json`),
    readStatus: async (path) => {
        try {
            return parseJsonWith((await readFile(path, "utf8")).trim(), AdminRunStatusSchema);
        } catch {
            // allow(silent-catch): no file is the answer itself: the run was killed at its deadline, or never got that far
            return undefined;
        } finally {
            await rm(path, { force: true });
        }
    },
});

/** The command remoted is started with, and the status file it answers in. */
export const adminInvocation = async (
    seams: AdminRunSeams,
    shell: { readonly command: string; readonly args: readonly string[] },
    cwd: string,
    grant?: string,
): Promise<{ readonly command: string; readonly args: string[]; readonly status: string }> => {
    let binary: string;
    try {
        binary = await seams.binary();
    } catch (error) {
        throw new ScopeError(`Not run: running as administrator needs intentic-remoted on this computer, and there is none to use: ${errorMessage(error)}`);
    }
    const status = seams.statusFile();
    return { command: binary, args: adminRunArgs(status, cwd, shell.command, shell.args, grant), status };
};

/**
 * What an admin run's ending comes to: undefined when the command ran (or was stopped at its deadline) and its result
 * stands as an ordinary run's, else the sentence the call fails with. Pure.
 */
export const adminRunVerdict = (
    status: AdminRunStatus | undefined,
    ended: { readonly timedOut: boolean; readonly exitCode: number | null; readonly stderr: string },
): string | undefined => {
    if (ended.timedOut || status?.ran === true) {
        return undefined;
    }
    if (status !== undefined) {
        return adminRunFailure(status);
    }
    const said = ended.stderr.trim().split(/\r?\n/u).slice(-3).join(" ").trim();
    return `Not run as administrator: intentic-remoted ended (exit ${String(ended.exitCode)}) without saying whether the command ran${said === "" ? "" : `: ${said}`}. It may be older than administrator runs; the agent update brings a newer one.`;
};
