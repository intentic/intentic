import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { whenAborted } from "@intentic/base/async";
import {
    LINK_OPERATE_WAIT_S_MAX,
    LinkExecSchema,
    type LinkExec,
    type LinkExecStatus,
    type LinkRead,
    type LinkReadAnswer,
    LinkReadSchema,
    type LinkWrite,
    type LinkWriteAnswer,
    LinkWriteSchema,
} from "@intentic/sandbox-contract/schemas/links";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { sealJailWanted } from "../conversations/seal/seal-jail.js";
import { peopleShellArgs } from "../conversations/worktrees/turn-sandbox.js";
import { CONTAINER_SECRET_ENV } from "../env.config.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { opt } from "../opt.js";
import { DAEMON_GEN_ENV, DAEMON_ONLY_ENV } from "../seams/workload-stamp.js";
import { ensureJailEmpty, shellJailFiles } from "../terminal/shell-jail.js";
import { type CheckOutcome, type CheckSpec, runCheck } from "../workload/run-check.js";
import { gitsRoot } from "../workspace/layout/git-dir-owners.js";
import type { InboundLinks, ResolvedLink } from "./inbound-links.js";
import { linkBody, presentedLink } from "./link-door.js";

/* OPERATING THIS SANDBOX OVER A LINK, the taking side (schemas/links.ts `operate`). Another of the owner's sandboxes runs
   commands and reads and writes files here as this sandbox's owner does in their own terminal, while the link's terms
   allow it. A delegated task cannot stand in for this: it is a whole agent turn in a checkout of its own, so a repair to
   the shared checkout (a `.git` pointer, a stuck branch) lands in that turn's copy instead (knot-xwrx, 2026-11-11).

   Where it runs is where a person's shell runs (terminal/shell-jail.ts): the main checkout, as root, or, while
   conversations here can be private (conversations/seal/seal-jail.ts), inside the same jail, which keeps the history
   volume and the workspace's secrets out of reach and leaves the main checkout and the git directories writable. Every
   call is logged with the link it came over; a command is read again rather than held open, so a long one never rests
   on one request outliving an edge's patience.

   The operations themselves are the operator's (`createOperator`), which a contact's `operate.*` calls run through too
   (links/contacts/contact-calls.ts), each command read and stopped by the party, link or contact, that started it. */

const NOT_ALLOWED =
    "This link may not operate this sandbox. Its owner can turn that on where the link is listed: Access, Programs, Linked sandboxes (Operate this sandbox).";
const JAIL_UNAVAILABLE =
    "Conversations in this sandbox can be private, so its commands run in the jail a person's shell gets, and this sandbox cannot build one (bubblewrap with user namespaces). Ask a maintainer to recreate it.";

// How long a settled command stays readable, and how many one link may run at once.
const KEPT_MS = 15 * 60_000;
const RUNNING_PER_LINK = 8;
// What is kept of each stream of a command (its end), and of a read (its start).
const EXEC_CAPTURE = 200_000;
const READ_CAPTURE = 512_000;
// A read or a write is answered in one call: a file that takes longer than this is no file to move over a link.
const FILE_TIMEOUT_MS = 30_000;
const READ_LINES_DEFAULT = 2_000;

// Where this sandbox's owner's own shell would run right now.
export type OperatePlace =
    | { readonly jailed: false }
    | { readonly jailed: true; readonly argv: (cwd: string, command: readonly string[]) => string[] }
    | { readonly refused: string };

// Who operates: a link, or a contact (links/contacts/contact-calls.ts). A command is read and stopped by the party that
// started it alone, and every log line names it the way its own door names it (`link: …`, `contact: …`).
export interface OperateParty {
    readonly kind: "link" | "contact";
    readonly id: string;
    readonly label: string;
}

// One operation's answer: what the door says at 200, or its refusal in words with the status the link doors answer it at.
export type OperateAnswer<T> = { readonly status: 200; readonly body: T } | { readonly status: 404 | 409 | 429 | 503; readonly body: { readonly error: string } };

export interface OperateDeps {
    readonly logger: Pick<Logger, "info" | "warn">;
    // The workspace root: where a relative path is read from, and where a command runs unless it names another.
    readonly root: string;
    readonly place: () => Promise<OperatePlace>;
    readonly run?: (spec: CheckSpec) => Promise<CheckOutcome>;
    readonly now?: () => number;
}

export interface LinkOperateDeps extends OperateDeps {
    readonly links: Pick<InboundLinks, "resolve" | "touch">;
}

interface ExecJob {
    readonly id: string;
    readonly party: string;
    readonly cwd: string;
    readonly jailed: boolean;
    readonly startedAt: number;
    readonly stop: AbortController;
    readonly done: Promise<void>;
    outcome?: CheckOutcome;
    failed?: string;
    endedAt?: number;
}

// The environment a person's shell gets: the daemon's, without what only the daemon may hold or the container's secrets
// (terminal/tmux-server.ts scrubs the same from the server every pane starts from).
const shellEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "dumb" };
    for (const name of [...DAEMON_ONLY_ENV, DAEMON_GEN_ENV, ...CONTAINER_SECRET_ENV]) {
        delete env[name];
    }
    return env;
};

/** A path as the asking side wrote it, made absolute against the workspace root. */
const operatePath = (root: string, path: string): string => normalize(isAbsolute(path) ? path : join(root, path));

const stateOf = (job: ExecJob): LinkExecStatus["state"] => {
    if (job.failed !== undefined || job.outcome?.spawnError !== undefined) {
        return "failed";
    }
    if (job.outcome === undefined) {
        return "running";
    }
    if (job.outcome.ended === "timeout") {
        return "timeout";
    }
    return job.outcome.ended === "aborted" ? "stopped" : "exited";
};

const statusOf = (job: ExecJob): LinkExecStatus => ({
    id: job.id,
    state: stateOf(job),
    ...opt("exitCode", job.outcome?.exitCode),
    ...opt("signal", job.outcome?.exitSignal),
    stdout: job.outcome?.stdout ?? "",
    stderr: job.outcome?.stderr ?? "",
    truncated: job.outcome?.truncated ?? false,
    ...opt("error", job.failed ?? job.outcome?.spawnError),
    cwd: job.cwd,
    jailed: job.jailed,
    startedAt: job.startedAt,
    ...opt("endedAt", job.endedAt),
});

// The first line a read prints before what it read: `D` for a directory, `F <bytes> <lines>` for a file.
const READ_SCRIPT = [
    `p=$1; start=$2; count=$3`,
    `if [ -d "$p" ]; then printf 'D\\n'; exec ls -la --group-directories-first -- "$p"; fi`,
    `[ -e "$p" ] || { echo "no such file or directory: $p" >&2; exit 2; }`,
    `[ -r "$p" ] || { echo "not readable: $p" >&2; exit 2; }`,
    `printf 'F %s %s\\n' "$(wc -c < "$p")" "$(wc -l < "$p")"`,
    `exec sed -n "\${start},$((start + count - 1))p" -- "$p"`,
].join("\n");
const WRITE_SCRIPT = `p=$1; mkdir -p -- "$(dirname -- "$p")" && cat > "$p"`;

// A number the read script printed, or undefined when it printed none.
const counted = (word: string | undefined): number | undefined => {
    const value = Number(word);
    return word === undefined || word === "" || !Number.isFinite(value) ? undefined : value;
};

/** What a read answers, from the read script's output: its first line says what was read, the rest is what it read. */
export const readAnswerOf = (path: string, outcome: Pick<CheckOutcome, "stdout" | "truncated">, jailed: boolean, window: { readonly start: number; readonly count: number }): LinkReadAnswer => {
    const newline = outcome.stdout.indexOf("\n");
    const head = (newline === -1 ? outcome.stdout : outcome.stdout.slice(0, newline)).split(" ");
    const content = newline === -1 ? "" : outcome.stdout.slice(newline + 1);
    if (head[0] === "D") {
        return { path, kind: "directory", content, truncated: outcome.truncated, jailed };
    }
    const lines = counted(head[2]);
    const binary = content.includes("\u0000");
    return {
        path,
        kind: "file",
        content: binary ? "" : content,
        ...opt("bytes", counted(head[1])),
        ...opt("lines", lines),
        ...opt("binary", binary ? true : undefined),
        truncated: outcome.truncated || (lines !== undefined && window.start + window.count - 1 < lines),
        jailed,
    };
};

// Why a read or a write did not answer, in the words it printed.
const failureOf = (outcome: CheckOutcome, what: string): string => outcome.stderr.trim() || outcome.spawnError || `the ${what} ended ${outcome.ended ?? "without an answer"}`;

// One command line placed where a person's shell runs, as the argv and directory to spawn it with.
const placed = (place: Exclude<OperatePlace, { refused: string }>, cwd: string, command: readonly string[]): Pick<CheckSpec, "argv" | "cwd"> =>
    place.jailed ? { argv: place.argv(cwd, command), cwd: "/" } : { argv: command, cwd };

// Holds a caller until the command ends, `waitS` passes, or the caller stops listening.
const settleWithin = async (job: ExecJob, waitS: number, signal: AbortSignal): Promise<void> => {
    if (job.endedAt !== undefined || waitS <= 0) {
        return;
    }
    let unwatch = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(waitS, LINK_OPERATE_WAIT_S_MAX) * 1_000);
            unwatch = whenAborted(signal, resolve);
        }),
    ]);
    clearTimeout(timer);
    unwatch();
};

interface ExecStart {
    readonly party: OperateParty;
    readonly place: Exclude<OperatePlace, { refused: string }>;
    readonly command: string;
    readonly cwd: string;
    readonly timeoutS: number;
    readonly from?: string | undefined;
}

// A party as its commands are keyed: a link and a contact never share an id space.
const partyKey = (party: OperateParty): string => `${party.kind}:${party.id}`;

// The commands links and contacts started here, each readable by the party that started it until a while after it ends.
const createExecJobs = (deps: Pick<OperateDeps, "logger">, run: NonNullable<OperateDeps["run"]>, now: () => number) => {
    const jobs = new Map<string, ExecJob>();
    const prune = (): void => {
        const at = now();
        for (const [id, job] of jobs) {
            if (job.endedAt !== undefined && at - job.endedAt > KEPT_MS) {
                jobs.delete(id);
            }
        }
    };
    return {
        running: (party: OperateParty): number => {
            prune();
            return [...jobs.values()].filter((job) => job.party === partyKey(party) && job.endedAt === undefined).length;
        },
        // Another party's command reads as none at all.
        of: (party: OperateParty, id: string): ExecJob | undefined => {
            const job = jobs.get(id);
            return job?.party === partyKey(party) ? job : undefined;
        },
        start: (start: ExecStart): ExecJob => {
            const { party, place, command, cwd } = start;
            let finish = (): void => {};
            const job: ExecJob = {
                id: `op-${randomUUID()}`,
                party: partyKey(party),
                cwd,
                jailed: place.jailed,
                startedAt: now(),
                stop: new AbortController(),
                done: new Promise<void>((resolve) => {
                    finish = resolve;
                }),
            };
            jobs.set(job.id, job);
            deps.logger.info(
                { [party.kind]: party.id, label: party.label, op: job.id, command: command.slice(0, 400), cwd, jailed: place.jailed, from: start.from },
                `${party.kind}: operating, a command`,
            );
            // runCheck never rejects; a run that somehow does reads as one that could not start.
            void run({
                ...placed(place, cwd, ["bash", "-lc", command]),
                env: shellEnv(),
                timeoutMs: start.timeoutS * 1_000,
                signal: job.stop.signal,
                workload: { class: "command" },
                kind: "link-operate",
                captureBytes: EXEC_CAPTURE,
                keep: "tail",
            })
                .then((outcome) => {
                    job.outcome = outcome;
                })
                .catch(() => {
                    job.failed = "it could not be run";
                })
                .finally(() => {
                    job.endedAt = now();
                    finish();
                    deps.logger.info(
                        { [party.kind]: party.id, op: job.id, state: stateOf(job), exitCode: job.outcome?.exitCode, ms: job.endedAt - job.startedAt },
                        `${party.kind}: operating, a command ended`,
                    );
                });
            return job;
        },
    };
};

export interface LinkOperateDoors {
    readonly exec: (c: Context<AppEnv>) => Promise<Response>;
    readonly status: (c: Context<AppEnv>) => Promise<Response>;
    readonly stop: (c: Context<AppEnv>) => Promise<Response>;
    readonly read: (c: Context<AppEnv>) => Promise<Response>;
    readonly write: (c: Context<AppEnv>) => Promise<Response>;
}

// A read or a write: one short command, answered whole, in the same place a command would run.
const fileCommandOf =
    (deps: Pick<OperateDeps, "place" | "root">, run: NonNullable<OperateDeps["run"]>) =>
    async (command: readonly string[], stdin?: string): Promise<{ readonly outcome: CheckOutcome; readonly jailed: boolean } | { readonly refused: string }> => {
        const place = await deps.place();
        if ("refused" in place) {
            return place;
        }
        const outcome = await run({
            ...placed(place, deps.root, command),
            env: shellEnv(),
            timeoutMs: FILE_TIMEOUT_MS,
            workload: { class: "command" },
            kind: "link-operate",
            captureBytes: READ_CAPTURE,
            ...opt("stdin", stdin),
        });
        return { outcome, jailed: place.jailed };
    };

const NO_SUCH_COMMAND = "This link started no command here by that id, or it ended long enough ago to be forgotten.";
const noSuchCommand = (party: OperateParty): string =>
    party.kind === "link" ? NO_SUCH_COMMAND : "This contact started no command here by that id, or it ended long enough ago to be forgotten.";

const refused = (status: 404 | 409 | 429 | 503, error: string): OperateAnswer<never> => ({ status, body: { error } });
const answered = <T>(body: T): OperateAnswer<T> => ({ status: 200, body });

// What one party may do here, each already allowed by its door: a command started and read again until it ends, a stop, a
// file's lines or a directory's listing, and a file written. The link doors (below) and a contact's operate calls
// (links/contacts/contact-calls.ts) answer through these same five.
export interface Operator {
    readonly exec: (party: OperateParty, exec: LinkExec, signal: AbortSignal) => Promise<OperateAnswer<LinkExecStatus>>;
    readonly status: (party: OperateParty, id: string, waitS: number, signal: AbortSignal) => Promise<OperateAnswer<LinkExecStatus>>;
    readonly stop: (party: OperateParty, id: string, signal: AbortSignal) => Promise<OperateAnswer<LinkExecStatus>>;
    readonly read: (party: OperateParty, read: LinkRead) => Promise<OperateAnswer<LinkReadAnswer>>;
    readonly write: (party: OperateParty, write: LinkWrite) => Promise<OperateAnswer<LinkWriteAnswer>>;
}

export const createOperator = (deps: OperateDeps): Operator => {
    const run = deps.run ?? runCheck;
    const jobs = createExecJobs(deps, run, deps.now ?? Date.now);
    const fileCommand = fileCommandOf(deps, run);
    return {
        exec: async (party, exec, signal) => {
            if (jobs.running(party) >= RUNNING_PER_LINK) {
                return refused(429, `This ${party.kind} already runs ${RUNNING_PER_LINK} commands here: wait for one to end, or stop one.`);
            }
            const place = await deps.place();
            if ("refused" in place) {
                return refused(503, place.refused);
            }
            const { command, timeoutS, waitS, from } = exec;
            const job = jobs.start({ party, place, command, cwd: operatePath(deps.root, exec.cwd ?? "."), timeoutS, from: from?.conversation });
            await settleWithin(job, waitS, signal);
            return answered(statusOf(job));
        },
        status: async (party, id, waitS, signal) => {
            const job = jobs.of(party, id);
            if (job === undefined) {
                return refused(404, noSuchCommand(party));
            }
            await settleWithin(job, waitS, signal);
            return answered(statusOf(job));
        },
        stop: async (party, id, signal) => {
            const job = jobs.of(party, id);
            if (job === undefined) {
                return refused(404, noSuchCommand(party));
            }
            if (job.endedAt === undefined) {
                deps.logger.info({ [party.kind]: party.id, op: job.id }, `${party.kind}: operating, a command stopped by the asking side`);
                job.stop.abort();
                await settleWithin(job, 5, signal);
            }
            return answered(statusOf(job));
        },
        read: async (party, read) => {
            const path = operatePath(deps.root, read.path);
            const window = { start: read.offset ?? 1, count: read.limit ?? READ_LINES_DEFAULT };
            deps.logger.info({ [party.kind]: party.id, label: party.label, path, from: read.from?.conversation }, `${party.kind}: operating, a read`);
            const done = await fileCommand(["sh", "-c", READ_SCRIPT, "sh", path, String(window.start), String(window.count)]);
            if ("refused" in done) {
                return refused(503, done.refused);
            }
            return done.outcome.exitCode === 0 ? answered(readAnswerOf(path, done.outcome, done.jailed, window)) : refused(404, failureOf(done.outcome, "read"));
        },
        write: async (party, write) => {
            const path = operatePath(deps.root, write.path);
            const bytes = Buffer.byteLength(write.content, "utf8");
            deps.logger.info({ [party.kind]: party.id, label: party.label, path, bytes, from: write.from?.conversation }, `${party.kind}: operating, a write`);
            const written = await fileCommand(["sh", "-c", WRITE_SCRIPT, "sh", path], write.content);
            if ("refused" in written) {
                return refused(503, written.refused);
            }
            return written.outcome.exitCode === 0 ? answered({ path, bytes, jailed: written.jailed } satisfies LinkWriteAnswer) : refused(409, failureOf(written.outcome, "write"));
        },
    };
};

// An operation's answer as a link door's response.
const respond = <T>(c: Context<AppEnv>, answer: OperateAnswer<T>): Response => (answer.status === 200 ? c.json(answer.body) : c.json(answer.body, answer.status));

const linkParty = (link: ResolvedLink): OperateParty => ({ kind: "link", id: link.id, label: link.label });

export const createLinkOperateDoors = (deps: LinkOperateDeps): LinkOperateDoors => {
    const operator = createOperator(deps);

    // The link the request presents, while its terms allow operating; the refusal otherwise.
    const operating = async (c: Context<AppEnv>): Promise<OperateParty | Response> => {
        const link = await presentedLink(deps, c);
        if (link instanceof Response) {
            return link;
        }
        return link.terms.operate ? linkParty(link) : c.json({ error: NOT_ALLOWED }, 403);
    };
    // A door behind the link.
    const behind =
        (door: (c: Context<AppEnv>, party: OperateParty) => Promise<Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const party = await operating(c);
            return party instanceof Response ? party : door(c, party);
        };
    // A door that reads a JSON body, behind the link.
    const withBody = <T>(schema: z.ZodType<T>, door: (party: OperateParty, body: T, c: Context<AppEnv>) => Promise<OperateAnswer<unknown>>) =>
        behind(async (c, party) => {
            const body = await linkBody(c, schema);
            return body.ok ? respond(c, await door(party, body.value, c)) : body.response;
        });

    return {
        exec: withBody(LinkExecSchema, (party, exec, c) => operator.exec(party, exec, c.req.raw.signal)),
        status: behind(async (c, party) => {
            const wait = Number.parseInt(c.req.query("wait") ?? "", 10);
            return respond(c, await operator.status(party, c.req.param("id") ?? "", Number.isFinite(wait) ? wait : 0, c.req.raw.signal));
        }),
        stop: behind(async (c, party) => respond(c, await operator.stop(party, c.req.param("id") ?? "", c.req.raw.signal))),
        read: withBody(LinkReadSchema, (party, read) => operator.read(party, read)),
        write: withBody(LinkWriteSchema, (party, write) => operator.write(party, write)),
    };
};

type PlaceServices = Pick<Services, "sealHouse" | "orgPolicy" | "agents" | "turnIsolation" | "workspace" | "config" | "sshAgent">;

/** Where a person's shell runs here right now: as root, or in the jail while conversations can be private. */
export const personShellPlace =
    (services: PlaceServices) =>
    async (): Promise<OperatePlace> => {
        if (!(await sealJailWanted(services))) {
            return { jailed: false };
        }
        if (!(await services.turnIsolation.sandboxAvailable())) {
            return { refused: JAIL_UNAVAILABLE };
        }
        const files = shellJailFiles();
        await ensureJailEmpty(files);
        const args = peopleShellArgs(services.workspace.root, { gits: gitsRoot(services.config.historyRoot), sshSocket: services.sshAgent.owner }, files.empty);
        return { jailed: true, argv: (cwd, command) => ["bwrap", ...args, "--chdir", cwd, "--", ...command] };
    };

export const linkOperateRawRoutes = defineRawRoutes((services: Services) => {
    const doors = createLinkOperateDoors({
        links: services.inboundLinks,
        logger: services.logger,
        root: services.workspace.root,
        place: personShellPlace(services),
    });
    return {
        "POST /link/operate/exec": doors.exec,
        "GET /link/operate/exec/{id}": doors.status,
        "POST /link/operate/exec/{id}/stop": doors.stop,
        "POST /link/operate/read": doors.read,
        "POST /link/operate/write": doors.write,
    };
});
