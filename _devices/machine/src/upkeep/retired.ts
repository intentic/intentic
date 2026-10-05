import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { autostart, type AutostartSpec, type Log } from "@intentic/local-agent";
import { peerLinkSilenceMs } from "@intentic/sandbox-contract/peer-dial";
import { machineLauncher } from "../supervision.js";
import type { Finding, UpkeepContext, UpkeepEntry } from "./entry.js";
import { exists, isInside, linkTarget, moveToTrash, processesFrom } from "./files.js";

/* WHAT THE AGENTS BEFORE THIS ONE LEFT. Until 2026-08-29 a device ran `intentic-host` (the device half) and
   `intentic-sync` with its mirror watcher (the sync half) as agents of their own, each with a login entry, a folder of
   its own under ~/.intentic and a link on PATH. The consolidated agent removed their login entries once, behind a single
   marker, and left the rest: rog still held 1.1 GB of `~/.intentic/sync`, last run in August, and either old binary,
   started by hand, would register its login entry again. */

// Only what each mechanism addresses an entry by (the unit and file names, the task and Run value, the launchd label);
// the rest of a spec is what registering needs, and is never read to remove one.
const retired = (base: string, id: string, windowsRunValue: string): AutostartSpec => ({
    id,
    windowsRunValue,
    desktopName: id,
    desktopComment: `retired: ${id}`,
    logPath: join(base, `${id}.log`),
    detachedArgs: [],
    foregroundArgs: [],
    failureNote: (reason) => reason,
});

// `intentic-host.service` / `IntenticHost` (no macOS entry, it never ran there) and `intentic-sync-mirror.service` /
// `IntenticSyncMirror` / `dev.intentic.sync-mirror`, each with its XDG `.desktop` file: named exactly as those agents
// registered them, since a name off by a letter removes nothing.
export const legacyAutostart = (base: string): readonly AutostartSpec[] => [
    retired(base, "intentic-host", "IntenticHost"),
    { ...retired(base, "intentic-sync-mirror", "IntenticSyncMirror"), launchAgent: { label: "dev.intentic.sync-mirror" } },
];

const quiet: Log = () => undefined;

// Once, behind its own marker, which the single `legacy-autostart-retired` of the builds before stands in for: asking
// every mechanism about two names is a dozen OS calls, and nothing writes these entries any more once the old folders
// are gone (below).
const retiredLoginEntries: UpkeepEntry = {
    id: "retired-login-entries",
    kind: "login-entry",
    action: "retire",
    reason: "the login entries of intentic-host and intentic-sync's mirror, the two agents this one replaced on 2026-08-29",
    once: true,
    formerMarker: "legacy-autostart-retired",
    find: async ({ base }) => {
        const found: Finding[] = [];
        for (const spec of legacyAutostart(base)) {
            const entry = autostart(spec, machineLauncher(), quiet);
            // oxlint-disable-next-line eslint/no-await-in-loop -- two entries, each a few OS calls; in order keeps them apart
            if (await entry.present()) {
                found.push({ what: `the ${spec.id} login entry`, act: async () => await entry.unregister() });
            }
        }
        return found;
    },
};

// The retired agents' folders under ~/.intentic, their links on PATH (only those that point into those folders: a link
// of the same name pointing anywhere else is somebody else's), and the copy of sync.json one migration set aside.
export const retiredPaths = (
    home: string,
    base: string,
): { readonly dirs: readonly string[]; readonly links: readonly string[]; readonly files: readonly string[] } => ({
    dirs: [join(home, ".intentic", "host"), join(home, ".intentic", "sync")],
    links: [join(home, ".local", "bin", "intentic-host"), join(home, ".local", "bin", "intentic-sync")],
    files: [join(base, "sync.json.bak-loopback")],
});

const trashing = (context: UpkeepContext, path: string): Finding => ({
    what: path,
    act: async () => void (await moveToTrash(context.base, path, context.now)),
});

const retiredGenerations: UpkeepEntry = {
    id: "retired-generations",
    kind: "retired-files",
    action: "trash",
    reason: "the folders, PATH links and leftovers of intentic-host and intentic-sync, which nothing has run since 2026-08-29",
    find: async (context) => {
        const { dirs, links, files } = retiredPaths(context.home, context.base);
        const found: Finding[] = [];
        for (const dir of dirs) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of paths, each a stat
            if (!(await exists(dir))) {
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            const running = await processesFrom(dir, context.platform);
            found.push(
                running !== undefined && running.length > 0
                    ? { what: dir, why: `a program from it is running (pid ${running.join(", ")}); it is moved once that has stopped` }
                    : trashing(context, dir),
            );
        }
        for (const link of links) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of paths, each a stat
            const target = await linkTarget(link);
            if (target !== undefined && dirs.some((dir) => isInside(target, dir))) {
                found.push(trashing(context, link));
            }
        }
        for (const file of files) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of paths, each a stat
            if (await exists(file)) {
                found.push(trashing(context, file));
            }
        }
        return found;
    },
};

/* `intentic-link-watch`: a timer someone made by hand on rog that restarted `intentic-machine.service` every two minutes
   while the agent's links were silent. That unit no longer exists where the agent runs as a child of the Windows side,
   and its own comment says to delete it once the agent has a silence watchdog. The link has one: a socket that hears
   nothing for `peerLinkSilenceMs` of the heartbeat is presumed dead and redialled (device/connection.ts). Linux only;
   the timer is turned off before its files go, or systemd keeps a unit whose file is missing. */
export const linkWatchPaths = (home: string): readonly string[] => [
    join(home, ".config", "systemd", "user", "intentic-link-watch.timer"),
    join(home, ".config", "systemd", "user", "intentic-link-watch.service"),
    join(home, ".config", "systemd", "user", "timers.target.wants", "intentic-link-watch.timer"),
    join(home, ".local", "bin", "intentic-link-watch"),
];

const userSystemctl = (...args: string[]): void => {
    spawnSync("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 30_000 });
};

// `systemctl` is passed in, so a test runs the entry without touching the user manager of whoever runs it.
export const linkWatchEntry = (systemctl: (...args: string[]) => void = userSystemctl): UpkeepEntry => ({
    id: "intentic-link-watch",
    kind: "workaround",
    action: "retire",
    reason: "a hand-made timer that restarts a unit which no longer exists, made for a silence watchdog the agent now has",
    find: async (context) => {
        if (context.platform !== "linux") {
            return [];
        }
        const present = (await Promise.all(linkWatchPaths(context.home).map(async (path) => ((await exists(path)) ? path : undefined)))).filter(
            (path): path is string => path !== undefined,
        );
        if (present.length === 0) {
            return [];
        }
        const what = `intentic-link-watch (${present.length} files)`;
        if (typeof peerLinkSilenceMs !== "function") {
            return [{ what, why: "this agent's links have no silence watchdog, so the workaround still does a job" }];
        }
        return [
            {
                what,
                act: async () => {
                    systemctl("disable", "--now", "intentic-link-watch.timer");
                    systemctl("stop", "intentic-link-watch.service");
                    for (const path of linkWatchPaths(context.home)) {
                        // oxlint-disable-next-line eslint/no-await-in-loop -- four paths, in order
                        if (await exists(path)) {
                            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
                            await moveToTrash(context.base, path, context.now);
                        }
                    }
                    systemctl("daemon-reload");
                },
            },
        ];
    },
});

export const RETIRED_ENTRIES: readonly UpkeepEntry[] = [retiredLoginEntries, retiredGenerations, linkWatchEntry()];
