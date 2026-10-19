import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import type { Ui } from "@intentic/local-agent";
import { deviceUninstall } from "../device/commands.js";
import { WINDOWS_SIDE } from "../environments/wsl.js";
import { syncUninstall } from "../sync/commands.js";
import { purgeDistros } from "./distros.js";
import { setAgentAside, type SweptFiles, sweepAgentFiles } from "./sweep.js";
import { sandboxTrashName } from "./plan.js";
import { removeFromPath, removeKeyring, removeLegacy, residentGone, restoreLinger, retireStartBeforeSignIn, stopApps, stopOwnMutagen } from "./steps.js";
import { stopOf, type Tally, tally } from "./tally.js";

/* `intentic-machine uninstall --purge [--delete-data]`: everything of the agent leaves this environment but the person's
   data (plan.ts), which goes too with --delete-data. The plain uninstall's teardown (links, pairings, the login entry)
   runs as it always has, after the WSL distros this PC's Windows side supervises are purged and let go, so nothing is
   left for the agent to stay running for. Then what the plain uninstall never touched: programs sandboxes started here,
   the keyring and askpass, what the agents before this one left, the PATH entry, lingering where the agent turned it on,
   and the files. Every step that does not finish is a warning with the command that finishes it; the run fails (exit
   1) only when the agent still runs or its files could not be removed. Nothing is downloaded. Order matters in three
   places: the distros go first, so the Windows side's agent has nothing left to keep; on Linux and macOS the binary is
   set aside before anything stops the agent, so a supervisor that starts it again finds none; the files go last, once
   nothing of the agent's holds them. */

// The plain uninstall's two halves, which in a purge may not stop the rest: what they could not do is said, and the
// purge goes on to remove what they left.
const teardown = async (say: Tally, deleteData: boolean): Promise<void> => {
    try {
        say.note(await syncUninstall(say, undefined, { forGood: true }));
    } catch (error) {
        say.warn(`File sync was not torn down cleanly (${errorMessage(error)}); its pairings go with the agent's files.`);
    }
    try {
        say.note(await deviceUninstall(say, undefined, { forGood: true, recordStays: !deleteData }));
    } catch (error) {
        say.warn(`The sandbox links were not removed cleanly (${errorMessage(error)}); they go with the agent's files.`);
    }
};

const DATA_WORDS: readonly (readonly [(name: string) => boolean, string, "machine" | "keyring"])[] = [
    [(name) => name === "vault.json", "your saved passwords (the keyring vault)", "keyring"],
    [(name) => name === "restore", "the restore points of your synced folders", "machine"],
    [(name) => name.startsWith("audit.jsonl"), "the record of what this agent did on this device", "machine"],
    [(name) => name.startsWith("trash/") && sandboxTrashName(name.slice("trash/".length)), "files a sandbox moved to this device's trash", "machine"],
];

// The data found, said in words: kept, or deleted as --delete-data asked.
const dataWords = (machine: readonly string[], keyring: readonly string[]): string[] =>
    DATA_WORDS.filter(([matches, , where]) => (where === "machine" ? machine : keyring).some(matches)).map(([, words]) => words);

const sayFiles = (say: Tally, swept: SweptFiles, deleteData: boolean): void => {
    if (swept.folders.length > 0) {
        say.note(`Removed the agent's files from ${swept.folders.join(" and ")}.`);
    }
    const words = dataWords(swept.machineData, swept.keyringData);
    if (words.length > 0) {
        say.note(
            deleteData
                ? `Deleted your data too, as asked: ${words.join("; ")}.`
                : `Kept your data, which only an uninstall that deletes data removes: ${words.join("; ")}.${swept.keyringData.includes("vault.json") ? " Set the keyring up again and the same passphrase opens the vault." : ""}`,
        );
    }
    if (swept.afterExit.length > 0) {
        say.note(`The last ${plural(swept.afterExit.length, "file")} still in use go once this program exits.`);
    }
    if (swept.stuck.length > 0) {
        say.fail(
            `${plural(swept.stuck.length, "path")} of the agent's could not be removed: ${swept.stuck.join(", ")}.`,
            process.platform === "win32" ? `Remove-Item -Recurse -Force ${swept.stuck.join(", ")}` : `rm -rf ${swept.stuck.join(" ")}`,
        );
    }
};

/** The whole purge, narrated through `ui`; throws the protocol's stop when the agent could not be removed. */
export const purgeAgent = async (ui: Ui, deleteData: boolean): Promise<void> => {
    const say = tally(ui);
    if (WINDOWS_SIDE) {
        await purgeDistros(deleteData, say);
    }
    await setAgentAside().catch((error: Error) => say.note(`The agent's binary could not be set aside first (${errorMessage(error)}); it goes with the files.`));
    await stopApps(say);
    await teardown(say, deleteData);
    if (process.platform === "win32") {
        await retireStartBeforeSignIn(say);
    }
    await residentGone(say);
    await stopOwnMutagen(say);
    const { holdBin } = await removeKeyring(say);
    await removeLegacy(say);
    if (!holdBin) {
        await removeFromPath(say);
    }
    restoreLinger(say);
    const swept = await sweepAgentFiles(deleteData, holdBin, say);
    sayFiles(say, swept, deleteData);
    const failures = say.failures();
    if (failures.length > 0) {
        throw new Error(stopOf("The agent was not removed from this device entirely.", failures));
    }
    const warnings = say.warnings();
    ui.done(
        warnings === 0
            ? "Removed the agent from this device. Nothing of it runs here any more."
            : `Removed the agent from this device; ${plural(warnings, "step")} above ${warnings === 1 ? "needs" : "need"} finishing by hand.`,
    );
};
