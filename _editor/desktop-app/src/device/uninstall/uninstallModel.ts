import type { IconName } from "@intentic/ui/icons";
import { formatFixed, formatList } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { FoundSandbox, UninstallChoice, UninstallInventory, UninstallOutcome, UninstallProgress, UninstallStep } from "../../desktopUninstall";

// THE UNINSTALL DIALOG, READ (UninstallDialog.vue draws it, src-tauri/src/uninstall.rs runs `ic uninstall`): what is on
// this computer and what each choice does to every part of it, the words of the choice and of the one button that acts
// on it, the typed count that stands between that button and a deletion, the arguments the run is given, and the
// checklist while it runs. Pure, so each case is tested by value (uninstallModel.test.ts).

/** What a choice does to one part of what Intentic put here. */
export type Fate = `deleted` | `removed` | `stays`;

/** What each choice does to one part. */
export interface Fates {
    readonly everything: Fate;
    readonly "keep-sandboxes": Fate;
}

/** One line of the ledger: a part of what is here, and what each choice does to it. */
export interface LedgerRow {
    readonly id: `sandboxes` | `passwords` | `engine` | `agent` | `sync` | `caches` | `app`;
    readonly icon: IconName;
    readonly title: string;
    readonly detail: string | undefined;
    /** Its size on disk, where ic could say. */
    readonly size: string | undefined;
    readonly fate: Fates;
}

/** One sandbox as the ledger names it under its row. */
export interface SandboxLine {
    readonly name: string;
    readonly state: string;
    readonly size: string | undefined;
}

/** What `uninstall_run` is called with. */
export interface RunArgs {
    readonly choice: UninstallChoice;
    /** The count the reader typed, for a deletion of sandboxes; null otherwise. */
    readonly confirm: number | null;
}

/** The sandboxes the ledger names one by one; the rest are a count. */
export const NAMED_SANDBOXES = 4;

/** Bytes as ic says them in its own lines (its uninstall `size`): decimal units, a place below a hundred. */
export const sizeOf = (bytes: number): string => {
    const units = [`KB`, `MB`, `GB`, `TB`];
    if (bytes < 1000) {
        return `${formatFixed(bytes, 0)} B`;
    }
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${formatFixed(value, value >= 100 ? 0 : 1)} ${units[unit]}`;
};

/** Anything of the reader's own an uninstall could delete: sandboxes (with their files), saved passwords. */
export const hasData = (inventory: UninstallInventory): boolean => inventory.deleteCount > 0 || inventory.passwords;

const runners = (inventory: UninstallInventory): number => inventory.sandboxes.filter((sandbox) => sandbox.kind === `runner`).length;

/** What a deletion takes, counted: "3 sandboxes", "1 runner", "2 sandboxes and 1 runner". `deleteCount` is the total,
 *  the recoverable ones included, since that is the number the reader types. */
export const thingsOf = (inventory: UninstallInventory): string => {
    const runnerCount = Math.min(runners(inventory), inventory.deleteCount);
    const sandboxCount = inventory.deleteCount - runnerCount;
    const sandboxes = t(`desktop.uninstall.sandboxes`, { count: sandboxCount }, sandboxCount);
    const runnerWords = t(`desktop.uninstall.runners`, { count: runnerCount }, runnerCount);
    if (runnerCount === 0) {
        return sandboxes;
    }
    return sandboxCount === 0 ? runnerWords : t(`desktop.uninstall.sandboxesAndRunners`, { sandboxes, runners: runnerWords });
};

/** The sandboxes' files on disk, as far as ic could measure them; undefined when it could measure none. */
export const dataBytes = (inventory: UninstallInventory): number | undefined => {
    const known = inventory.sandboxes.flatMap((sandbox) => (sandbox.bytes === null || sandbox.bytes <= 0 ? [] : [sandbox.bytes]));
    return known.length === 0 ? undefined : known.reduce((sum, bytes) => sum + bytes, 0);
};

/** A size ic measured, as the ledger says it; undefined for one it could not. */
const sizeOrNone = (bytes: number | null | undefined): string | undefined => (bytes === null || bytes === undefined || bytes <= 0 ? undefined : sizeOf(bytes));

/** One sandbox as the ledger names it under its row: its name, how it stands, its size. */
export const sandboxLine = (sandbox: FoundSandbox): SandboxLine => {
    // ic says `unknown` for a container docker could not describe: then nothing is said about how it stands.
    let state = ``;
    if (sandbox.state === `running`) {
        state = t(`desktop.uninstall.sandboxRunning`);
    } else if (sandbox.state === `removed`) {
        state = t(`desktop.uninstall.sandboxRemoved`);
    } else if (sandbox.state === `stopped`) {
        state = t(`desktop.uninstall.sandboxStopped`);
    }
    return { name: sandbox.slug, state, size: sizeOrNone(sandbox.bytes) };
};

const both = (fate: Fate): Fates => ({ everything: fate, "keep-sandboxes": fate });

/** What happens to a part, in one word at the end of its line. */
export const fateWord = (fate: Fate): string => {
    switch (fate) {
        case `deleted`:
            return t(`desktop.uninstall.fateDeleted`);
        case `stays`:
            return t(`desktop.uninstall.fateStays`);
        default:
            return t(`desktop.uninstall.fateRemoved`);
    }
};

/** Everything Intentic put here, in the order a person thinks of it: their own things first, then what ran them, then
 *  the app. Each row says what each choice does to it; the app's own row is always there, since the app is running. */
export const ledger = (inventory: UninstallInventory, appVersion?: string): LedgerRow[] => {
    const rows: LedgerRow[] = [];
    if (inventory.deleteCount > 0) {
        rows.push({
            id: `sandboxes`,
            icon: `box`,
            title: thingsOf(inventory),
            detail: undefined,
            size: sizeOrNone(dataBytes(inventory)),
            fate: { everything: `deleted`, "keep-sandboxes": `stays` },
        });
    }
    if (inventory.passwords) {
        rows.push({
            id: `passwords`,
            icon: `key`,
            title: t(`desktop.uninstall.rowPasswords`),
            detail: t(`desktop.uninstall.rowPasswordsDetail`),
            size: undefined,
            fate: { everything: `deleted`, "keep-sandboxes": `stays` },
        });
    }
    const engine = inventory.engine;
    if (engine !== null) {
        rows.push({
            id: `engine`,
            icon: `server`,
            title: t(`desktop.uninstall.rowEngine`),
            detail: engine.holdsOthers ? t(`desktop.uninstall.rowEngineShared`) : undefined,
            size: sizeOrNone(engine.bytes),
            // An engine that also runs containers that are not Intentic's is not Intentic's alone to remove.
            fate: engine.holdsOthers ? both(`stays`) : { everything: `removed`, "keep-sandboxes": `stays` },
        });
    }
    const agent = inventory.agent;
    if (agent !== null) {
        rows.push({
            id: `agent`,
            icon: `robot`,
            title: t(`desktop.uninstall.rowAgent`),
            detail: agent.distros.length > 0 ? t(`desktop.uninstall.rowAgentDistros`, { distros: formatList(agent.distros) }) : undefined,
            size: undefined,
            fate: { everything: `removed`, "keep-sandboxes": `stays` },
        });
        if (agent.folders > 0) {
            rows.push({
                id: `sync`,
                icon: `sync`,
                title: t(`desktop.uninstall.rowSync`),
                detail: t(`desktop.uninstall.rowSyncDetail`, { count: agent.folders }, agent.folders),
                size: undefined,
                fate: both(`removed`),
            });
        }
    }
    if (inventory.cacheBytes > 0) {
        rows.push({
            id: `caches`,
            icon: `database`,
            title: t(`desktop.uninstall.rowCaches`),
            detail: undefined,
            size: sizeOf(inventory.cacheBytes),
            fate: both(`removed`),
        });
    }
    const version = inventory.app?.version ?? appVersion;
    rows.push({
        id: `app`,
        icon: `desktop`,
        title: t(`desktop.uninstall.rowApp`),
        detail: version === undefined || version === `` || version === `0.0.0` ? undefined : t(`desktop.uninstall.rowAppVersion`, { version }),
        size: undefined,
        fate: both(`removed`),
    });
    return rows;
};

/** The choice the dialog opens on: what someone uninstalling a product asked for. The typed count guards it. */
export const DEFAULT_CHOICE: UninstallChoice = `everything`;

/** The choice that runs: with nothing of the reader's here there is no choice, and everything goes. */
const choiceOf = (inventory: UninstallInventory, picked: UninstallChoice): UninstallChoice => (hasData(inventory) ? picked : `everything`);

/** Whether the reader types the count before the button acts: only when sandboxes are about to be deleted. */
export const needsCount = (inventory: UninstallInventory, picked: UninstallChoice): boolean =>
    choiceOf(inventory, picked) === `everything` && inventory.deleteCount > 0;

/** Whether the button may act: the count typed is the count ic will delete, digits only, spaces forgiven. */
export const countTyped = (inventory: UninstallInventory, picked: UninstallChoice, typed: string): boolean =>
    !needsCount(inventory, picked) || typed.trim() === String(inventory.deleteCount);

/** What `uninstall_run` is called with: the choice, and for a deletion of sandboxes the count the reader typed. */
export const runArgs = (inventory: UninstallInventory, picked: UninstallChoice): RunArgs => {
    const choice = choiceOf(inventory, picked);
    return { choice, confirm: needsCount(inventory, picked) ? inventory.deleteCount : null };
};

/** The one button that acts, saying exactly what it does. */
export const primaryLabel = (inventory: UninstallInventory, picked: UninstallChoice): string => {
    if (!hasData(inventory)) {
        return t(`desktop.uninstall.uninstall`);
    }
    const keepsSandboxes = inventory.deleteCount > 0;
    if (choiceOf(inventory, picked) === `keep-sandboxes`) {
        return keepsSandboxes ? t(`desktop.uninstall.uninstallKeepSandboxes`) : t(`desktop.uninstall.uninstallKeepPasswords`);
    }
    return keepsSandboxes ? t(`desktop.uninstall.uninstallDelete`, { things: thingsOf(inventory) }) : t(`desktop.uninstall.uninstallDeletePasswords`);
};

/** A choice's words: a title, and what it does in plain words. */
export interface ChoiceWords {
    readonly title: string;
    readonly body: string;
}

/** The two choices' words. */
export interface Choices {
    readonly everything: ChoiceWords;
    readonly "keep-sandboxes": ChoiceWords;
}

const everythingBody = (inventory: UninstallInventory): string => {
    const things = thingsOf(inventory);
    const bytes = dataBytes(inventory);
    const size = bytes === undefined ? undefined : sizeOf(bytes);
    const sandboxes = inventory.deleteCount > 0;
    let deletes: string;
    if (sandboxes && inventory.passwords) {
        deletes =
            size === undefined
                ? t(`desktop.uninstall.everythingSandboxesPasswords`, { things })
                : t(`desktop.uninstall.everythingSandboxesPasswordsSized`, { things, size });
    } else if (sandboxes) {
        deletes = size === undefined ? t(`desktop.uninstall.everythingSandboxes`, { things }) : t(`desktop.uninstall.everythingSandboxesSized`, { things, size });
    } else {
        deletes = t(`desktop.uninstall.everythingPasswords`);
    }
    return `${deletes} ${t(`desktop.uninstall.cantUndo`)}`;
};

export const choiceWords = (inventory: UninstallInventory): Choices => {
    const sandboxes = inventory.deleteCount > 0;
    const syncs = (inventory.agent?.folders ?? 0) > 0;
    const keepBody = sandboxes
        ? syncs
            ? t(`desktop.uninstall.keepSandboxesBody`)
            : t(`desktop.uninstall.keepSandboxesBodyNoSync`)
        : syncs
          ? t(`desktop.uninstall.keepPasswordsBody`)
          : t(`desktop.uninstall.keepPasswordsBodyNoSync`);
    return {
        everything: { title: t(`desktop.uninstall.everythingTitle`), body: everythingBody(inventory) },
        "keep-sandboxes": {
            title: sandboxes ? t(`desktop.uninstall.keepSandboxesTitle`) : t(`desktop.uninstall.keepPasswordsTitle`),
            body: keepBody,
        },
    };
};

/** The question the two choices answer. */
export const choiceQuestion = (inventory: UninstallInventory): string =>
    inventory.deleteCount > 0 ? t(`desktop.uninstall.choiceSandboxes`) : t(`desktop.uninstall.choicePasswords`);

/** What stays whatever was chosen, as one sentence; none when ic named nothing. */
export const staysSentence = (stays: readonly string[]): string | undefined =>
    stays.length === 0 ? undefined : t(`desktop.uninstall.stays`, { list: formatList(stays) });

/* WHILE IT RUNS. */

/** The checklist: ic's own once it has said its plan, the inventory's plan for the choice until then. */
export const checklistOf = (inventory: UninstallInventory | undefined, choice: UninstallChoice, progress: UninstallProgress | undefined): UninstallStep[] => {
    if (progress !== undefined && progress.steps.length > 0) {
        return [...progress.steps];
    }
    return (inventory?.steps[choice] ?? []).map((planned) => ({ step: planned.step, label: planned.label, state: `pending`, detail: null }));
};

const OVER: ReadonlySet<string> = new Set([`done`, `failed`, `skipped`]);

/** The step to put in front of the reader: the one running, else the next to run. */
export const currentStep = (steps: readonly UninstallStep[]): UninstallStep | undefined =>
    steps.find((step) => step.state === `running`) ?? steps.find((step) => !OVER.has(step.state));

/** How far through the plan, in percent: a step counts once it is over, however it ended. */
export const percentOf = (steps: readonly UninstallStep[]): number =>
    steps.length === 0 ? 0 : Math.round((100 * steps.filter((step) => OVER.has(step.state)).length) / steps.length);

/** Whether everything planned came off. */
export const cleanEnd = (outcome: UninstallOutcome): boolean => outcome.result === `done` && outcome.failed.length === 0;

/** What stays after it, as ic said at the end, else as it said before it began. */
export const staysAfter = (outcome: UninstallOutcome | null | undefined, inventory: UninstallInventory | undefined): readonly string[] =>
    outcome !== null && outcome !== undefined && outcome.stays.length > 0 ? outcome.stays : (inventory?.stays ?? []);
