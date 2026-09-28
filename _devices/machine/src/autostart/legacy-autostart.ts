import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autostart, type AutostartSpec, type Log } from "@intentic/local-agent";
import { baseDir } from "../config.js";
import { machineLauncher } from "../supervision.js";

// THE LOGIN ENTRIES OF THE TWO AGENTS THIS ONE REPLACED. Until 2026-08-29 a device ran `intentic-host` (the device half)
// and `intentic-sync`'s mirror watcher (the sync half) as agents of their own, each registered to start at login. The
// consolidated agent never removed their entries, so a machine that ran either still starts a retired binary at every
// sign-in, or tries to. They are removed once, by the first agent of this release to start here.

// Only what each mechanism addresses an entry by (the unit and file names, the task and Run value, the launchd label);
// the rest of a spec is what registering needs, and is never read to remove one.
const retired = (id: string, windowsRunValue: string): AutostartSpec => ({
    id,
    windowsRunValue,
    desktopName: id,
    desktopComment: `retired: ${id}`,
    logPath: join(baseDir, `${id}.log`),
    detachedArgs: [],
    foregroundArgs: [],
    failureNote: (reason) => reason,
});

// `intentic-host.service` / `IntenticHost` (no macOS entry, it never ran there) and `intentic-sync-mirror.service` /
// `IntenticSyncMirror` / `dev.intentic.sync-mirror`, each with its XDG `.desktop` file.
export const LEGACY_AUTOSTART: readonly AutostartSpec[] = [
    retired("intentic-host", "IntenticHost"),
    { ...retired("intentic-sync-mirror", "IntenticSyncMirror"), launchAgent: { label: "dev.intentic.sync-mirror" } },
];

// Written once the entries are gone, so later starts do not ask the OS again.
const retiredPath = join(baseDir, "legacy-autostart-retired");

// Every mechanism's entry for both, whichever the machine had: removing one that is not there is a no-op.
export const retireLegacyAutostart = async (log: Log): Promise<void> => {
    if (existsSync(retiredPath)) {
        return;
    }
    const quiet: Log = () => undefined;
    for (const spec of LEGACY_AUTOSTART) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- two entries, each a few OS calls; in order keeps them apart
        await autostart(spec, machineLauncher(), quiet).unregister();
    }
    await writeFile(retiredPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    log("removed the login entries intentic-host and intentic-sync's mirror left before they became this agent, wherever any were left.");
};
