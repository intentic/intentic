import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { forkedExec } from "@intentic/base/git";
import { writeFileAtomic } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX, PANEL_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { SERVICE_SESSION_PREFIX } from "./terminal-session.js";
import { HOLDER_SESSION, isNoTmuxServer } from "./tmux-server.js";

/* A PERSON'S SHELL IN THE JAIL (2026-11-04). While conversations can be private (conversations/seal/seal-jail.ts), a shell
   opened from the editor must not read the history volume either: a root shell there reads every transcript, the
   owner's included. netd makes a person's session with no command of its own (netd term/mod.rs tmux_argv), so tmux
   starts it with the server's `default-command`; while the jail is wanted that is a line which starts the shell inside a
   sandbox of its own (turn-sandbox.ts shellJailArgs), one per pane, ended with it. A session the daemon makes for its own
   work (a panel's process, a job, a turn's panes, the server pin) keeps the shell it always had: those run commands the
   daemon chose, and a job such as a sign-in must write the real HOME. The line is the tmux server's own child, outside
   every sandbox, and reads its arguments from a file only root can read, so nothing a person types can change them; it
   fails closed: a missing argument file or a sandbox that cannot start ends the pane rather than open a shell outside.
   Sessions a person opened before the jail was wanted are ended, since their shells run outside it. */

const SHELL_JAIL_DIR = "/run/intentic/shell-jail";
// The pane option the line sets before it starts the sandbox: how a sweep tells a jailed shell from one opened before.
const JAIL_MARK = "@intentic_jail";
// Where the line starts with, so the daemon knows the server's default-command for its own.
const LINE_MARK = ": intentic-shell-jail;";
const DAEMON_SESSIONS = [`${PANEL_SESSION_PREFIX}*`, `${JOB_SESSION_PREFIX}*`, `${AGENT_SESSION_PREFIX}*`, `${SERVICE_SESSION_PREFIX}*`, HOLDER_SESSION];

export interface ShellJailFiles {
    readonly dir: string;
    readonly args: string;
    // The default-command the server had before the jail, put back once it is no longer wanted.
    readonly original: string;
    // When the jail's line became the default-command, in epoch seconds: sessions made since started jailed.
    readonly armedAt: string;
    // An empty file every mask in the shell's sandbox reads from (turn-sandbox.ts SandboxLayout.empty).
    readonly empty: string;
}

export const shellJailFiles = (dir: string = SHELL_JAIL_DIR): ShellJailFiles => ({
    dir,
    args: join(dir, "args"),
    original: join(dir, "default-command"),
    armedAt: join(dir, "armed-at"),
    empty: join(dir, "empty"),
});

/** The default-command that starts a person's shell in the jail, and any daemon session's as `original` would. */
export const jailedDefaultCommand = (original: string, files: Pick<ShellJailFiles, "args">): string => {
    // An empty default-command is tmux's own default: the default-shell, as a login shell.
    const shell = original.trim() === "" ? `"$SHELL" -l` : original;
    return [
        LINE_MARK,
        `case "$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" in ${DAEMON_SESSIONS.join("|")}) exec ${shell};; esac;`,
        `tmux set-option -p -t "$TMUX_PANE" ${JAIL_MARK} 1 2>/dev/null;`,
        `exec /usr/bin/bwrap --args 3 --chdir "$PWD" -- ${shell} 3<${shellQuote(files.args)}`,
    ].join(" ");
};

export const isJailedDefaultCommand = (command: string): boolean => command.trimStart().startsWith(LINE_MARK);

const daemonSession = (name: string): boolean =>
    name === HOLDER_SESSION || [PANEL_SESSION_PREFIX, JOB_SESSION_PREFIX, AGENT_SESSION_PREFIX, SERVICE_SESSION_PREFIX].some((prefix) => name.startsWith(prefix));

/**
 * The people's sessions to end once the jail is wanted, from `list-panes -a` rows of session name, creation (epoch
 * seconds) and the pane's mark: made before the line was armed and holding a shell it did not start. Pure, so the rule
 * is pinned without a server.
 */
export const unjailedSessions = (listing: string, armedAt: number): string[] => {
    const found = new Set<string>();
    for (const row of listing.split("\n")) {
        const [name, created, mark] = row.split("\t");
        if (name === undefined || name === "" || daemonSession(name) || mark === "1") {
            continue;
        }
        const at = Number(created);
        if (Number.isFinite(at) && at < armedAt) {
            found.add(name);
        }
    }
    return [...found];
};

export type Tmux = (args: readonly string[]) => Promise<string>;

const runTmux: Tmux = async (args) => (await forkedExec("tmux", args, { timeout: 10_000 })).stdout;

const defaultCommandOf = async (tmux: Tmux): Promise<string> => (await tmux(["show-options", "-gv", "default-command"])).replace(/\n$/u, "");

// Written aside and renamed into place (writeFileAtomic), so the line never reads half an argument list.
const writeAtomic = (path: string, content: string | Uint8Array, mode: number): Promise<void> => writeFileAtomic(path, content, mode);

// One at a time: arming twice at once could read the line back as the server's own default-command and save it so.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    // allow(silent-catch): the queue only orders the work; whoever asked for it is answered its failure through `next`.
    queue = next.catch(() => undefined);
    return next;
};

/**
 * Puts every new person's shell in the jail `args` builds (bwrap arguments, without the command), and ends the people's
 * sessions opened outside it. Throws when the server cannot be told, for the caller to refuse the terminal: a shell
 * outside the jail is never the fallback.
 */
export const armShellJail = (args: readonly string[], files: ShellJailFiles = shellJailFiles(), tmux: Tmux = runTmux): Promise<void> =>
    serial(async () => {
        await mkdir(files.dir, { recursive: true, mode: 0o700 });
        await writeAtomic(files.empty, "", 0o444);
        await writeAtomic(files.args, Buffer.from(args.map((arg) => `${arg}\0`).join(""), "utf8"), 0o600);
        // The server must be up before it is told, or the next terminal's client would fork one with the image's own line.
        await tmux(["new-session", "-A", "-d", "-s", HOLDER_SESSION]);
        try {
            const current = await defaultCommandOf(tmux);
            const original = isJailedDefaultCommand(current) ? ((await readFile(files.original, "utf8").catch(undefinedIfMissing)) ?? "zsh") : current;
            const line = jailedDefaultCommand(original, files);
            if (current !== line) {
                await writeAtomic(files.original, original, 0o600);
                await tmux(["set-option", "-g", "default-command", line]);
                await writeAtomic(files.armedAt, String(Math.floor(Date.now() / 1_000)), 0o600);
            }
        } finally {
            // allow(silent-catch): the pin is gone already when a person's session was made meanwhile; exit-empty is off.
            await tmux(["kill-session", "-t", `=${HOLDER_SESSION}`]).catch(() => undefined);
        }
        const armedAt = Number((await readFile(files.armedAt, "utf8").catch(undefinedIfMissing)) ?? "0");
        const listing = await tmux(["list-panes", "-a", "-F", `#{session_name}\t#{session_created}\t#{${JAIL_MARK}}`]);
        for (const session of unjailedSessions(listing, armedAt)) {
            // allow(silent-catch): a session already gone is what this asks for.
            await tmux(["kill-session", "-t", `=${session}`]).catch(() => undefined);
        }
    });

/** Puts the server's own default-command back once the jail is no longer wanted; nothing when it was never armed. */
export const disarmShellJail = (files: ShellJailFiles = shellJailFiles(), tmux: Tmux = runTmux): Promise<void> =>
    serial(async () => {
        // Never armed, by this daemon or one before it since the container started: nothing to ask tmux.
        if ((await stat(files.args).catch(undefinedIfMissing)) === undefined) {
            return;
        }
        let current: string;
        try {
            current = await defaultCommandOf(tmux);
        } catch (error) {
            // No server is no line to take back: the next one starts from the image's own configuration.
            if (isNoTmuxServer(error)) {
                return;
            }
            throw error;
        }
        if (!isJailedDefaultCommand(current)) {
            return;
        }
        const original = (await readFile(files.original, "utf8").catch(undefinedIfMissing)) ?? "zsh";
        await tmux(["set-option", "-g", "default-command", original]);
        await rm(files.args, { force: true });
    });
