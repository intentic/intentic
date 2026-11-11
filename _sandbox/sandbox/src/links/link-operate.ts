import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { whenAborted } from "@intentic/base/async";
import {
    LINK_OPERATE_WAIT_S_MAX,
    LinkExecSchema,
    type LinkExecStatus,
    type LinkReadAnswer,
    LinkReadSchema,
    type LinkWriteAnswer,
    LinkWriteSchema,
} from "@intentic/sandbox-contract/schemas/links";
import type { Context } from "hono";
import type { Logger } from "pino";
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
   on one request outliving an edge's patience. */

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

export interface LinkOperateDeps {
    readonly links: Pick<InboundLinks, "resolve" | "touch">;
    readonly logger: Pick<Logger, "info" | "warn">;
    // The workspace root: where a relative path is read from, and where a command runs unless it names another.
    readonly root: string;
    readonly place: () => Promise<OperatePlace>;
    readonly run?: (spec: CheckSpec) => Promise<CheckOutcome>;
    readonly now?: () => number;
}

interface ExecJob {
    readonly id: string;
    readonly linkId: string;
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
    readonly link: ResolvedLink;
    readonly place: Exclude<OperatePlace, { refused: string }>;
    readonly command: string;
    readonly cwd: string;
    readonly timeoutS: number;
    readonly from?: string | undefined;
}

// The commands links started here, each readable by the link that started it until a while after it ends.
const createExecJobs = (deps: Pick<LinkOperateDeps, "logger">, run: NonNullable<LinkOperateDeps["run"]>, now: () => number) => {
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
        running: (linkId: string): number => {
            prune();
            return [...jobs.values()].filter((job) => job.linkId === linkId && job.endedAt === undefined).length;
        },
        // Another link's command reads as none at all.
        of: (linkId: string, id: string): ExecJob | undefined => {
            const job = jobs.get(id);
            return job?.linkId === linkId ? job : undefined;
        },
        start: (start: ExecStart): ExecJob => {
            const { link, place, command, cwd } = start;
            let finish = (): void => {};
            const job: ExecJob = {
                id: `op-${randomUUID()}`,
                linkId: link.id,
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
                { link: link.id, label: link.label, op: job.id, command: command.slice(0, 400), cwd, jailed: place.jailed, from: start.from },
                "link: operating, a command",
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
                        { link: link.id, op: job.id, state: stateOf(job), exitCode: job.outcome?.exitCode, ms: job.endedAt - job.startedAt },
                        "link: operating, a command ended",
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
    (deps: Pick<LinkOperateDeps, "place" | "root">, run: NonNullable<LinkOperateDeps["run"]>) =>
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

export const createLinkOperateDoors = (deps: LinkOperateDeps): LinkOperateDoors => {
    const run = deps.run ?? runCheck;
    const jobs = createExecJobs(deps, run, deps.now ?? Date.now);
    const fileCommand = fileCommandOf(deps, run);

    // The link the request presents, while its terms allow operating; the refusal otherwise.
    const operating = async (c: Context<AppEnv>): Promise<ResolvedLink | Response> => {
        const link = await presentedLink(deps, c);
        if (link instanceof Response) {
            return link;
        }
        return link.terms.operate ? link : c.json({ error: NOT_ALLOWED }, 403);
    };
    // A door behind the link, with the command its path names when it names one.
    const behind =
        (door: (c: Context<AppEnv>, link: ResolvedLink) => Promise<Response>) =>
        async (c: Context<AppEnv>): Promise<Response> => {
            const link = await operating(c);
            return link instanceof Response ? link : door(c, link);
        };
    const withJob = (door: (c: Context<AppEnv>, job: ExecJob, link: ResolvedLink) => Promise<Response>) =>
        behind(async (c, link) => {
            const job = jobs.of(link.id, c.req.param("id") ?? "");
            return job === undefined ? c.json({ error: NO_SUCH_COMMAND }, 404) : door(c, job, link);
        });

    return {
        exec: behind(async (c, link) => {
            const body = await linkBody(c, LinkExecSchema);
            if (!body.ok) {
                return body.response;
            }
            if (jobs.running(link.id) >= RUNNING_PER_LINK) {
                return c.json({ error: `This link already runs ${RUNNING_PER_LINK} commands here: wait for one to end, or stop one.` }, 429);
            }
            const place = await deps.place();
            if ("refused" in place) {
                return c.json({ error: place.refused }, 503);
            }
            const { command, timeoutS, waitS, from } = body.value;
            const job = jobs.start({ link, place, command, cwd: operatePath(deps.root, body.value.cwd ?? "."), timeoutS, from: from?.conversation });
            await settleWithin(job, waitS, c.req.raw.signal);
            return c.json(statusOf(job));
        }),
        status: withJob(async (c, job) => {
            const wait = Number.parseInt(c.req.query("wait") ?? "", 10);
            await settleWithin(job, Number.isFinite(wait) ? wait : 0, c.req.raw.signal);
            return c.json(statusOf(job));
        }),
        stop: withJob(async (c, job, link) => {
            if (job.endedAt === undefined) {
                deps.logger.info({ link: link.id, op: job.id }, "link: operating, a command stopped by the asking side");
                job.stop.abort();
                await settleWithin(job, 5, c.req.raw.signal);
            }
            return c.json(statusOf(job));
        }),
        read: behind(async (c, link) => {
            const body = await linkBody(c, LinkReadSchema);
            if (!body.ok) {
                return body.response;
            }
            const path = operatePath(deps.root, body.value.path);
            const window = { start: body.value.offset ?? 1, count: body.value.limit ?? READ_LINES_DEFAULT };
            deps.logger.info({ link: link.id, label: link.label, path, from: body.value.from?.conversation }, "link: operating, a read");
            const read = await fileCommand(["sh", "-c", READ_SCRIPT, "sh", path, String(window.start), String(window.count)]);
            if ("refused" in read) {
                return c.json({ error: read.refused }, 503);
            }
            return read.outcome.exitCode === 0
                ? c.json(readAnswerOf(path, read.outcome, read.jailed, window))
                : c.json({ error: failureOf(read.outcome, "read") }, 404);
        }),
        write: behind(async (c, link) => {
            const body = await linkBody(c, LinkWriteSchema);
            if (!body.ok) {
                return body.response;
            }
            const path = operatePath(deps.root, body.value.path);
            const bytes = Buffer.byteLength(body.value.content, "utf8");
            deps.logger.info({ link: link.id, label: link.label, path, bytes, from: body.value.from?.conversation }, "link: operating, a write");
            const written = await fileCommand(["sh", "-c", WRITE_SCRIPT, "sh", path], body.value.content);
            if ("refused" in written) {
                return c.json({ error: written.refused }, 503);
            }
            return written.outcome.exitCode === 0
                ? c.json({ path, bytes, jailed: written.jailed } satisfies LinkWriteAnswer)
                : c.json({ error: failureOf(written.outcome, "write") }, 409);
        }),
    };
};

type PlaceServices = Pick<Services, "sealHouse" | "orgPolicy" | "agents" | "turnIsolation" | "workspace" | "config" | "sshAgent">;

/** Where a person's shell runs here right now: as root, or in the jail while conversations can be private. */
const personShellPlace =
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
