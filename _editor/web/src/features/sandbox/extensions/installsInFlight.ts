import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { extensionStatuses } from "../../../workbench/views/extensionStatuses";
import { type Operation, operationsUnder } from "../../../workbench/operations/operations";
import type { InstallOutcome } from "./discoverListing";

// Installs and updates started from Browse, kept in the operations ledger under one key per listing name rather than in
// the view that starts them: switching to the Installed pill unmounts Browse while the clone runs on, and coming back
// has to show it still running, and then how it ended, rather than offer Install a second time. The ledger stamps each
// with the sandbox it began on, since the clone runs in the box it was started on. A run's value is its verb; what it
// came to is read off the list when it is drawn (installOutcome).

export const INSTALLS = `extensions/install`;
export type InstallVerb = InstallOutcome["verb"];
export type InstallRun = Operation<InstallVerb>;

/** The listing name an install's key is filed under. */
export const listingOf = (key: string): string => key.slice(INSTALLS.length + 1);

/** The listings being installed or updated in this sandbox right now. */
export const installsInFlight = computed<ReadonlySet<string>>(
    () => new Set(operationsUnder(INSTALLS).flatMap((operation) => (operation.state === `running` ? [listingOf(operation.key)] : []))),
);

// What an install came to once the host has reconciled, read off the list and this browser's load record: a switch
// left off survives an update, and a bundle that threw in activate() is installed all the same. Found by identity,
// since a hand-installed copy may carry another id than the listing would derive.
const NOT_STARTED = new Set([`error`, `incompatible`, `missing`]);
export const installOutcome = (name: string, verb: InstallVerb, extensions: readonly ExtensionSummary[]): InstallOutcome => {
    const here = extensions.find((extension) => extensionIdOf(extension.manifest) === name);
    const status = here === undefined ? undefined : extensionStatuses.value.find((loaded) => loaded.id === here.id);
    return {
        verb,
        id: here?.id,
        problem: status !== undefined && NOT_STARTED.has(status.state) ? (status.detail ?? status.state) : undefined,
        off: here?.enabled === false,
        settings: (here?.manifest.contributes?.settings ?? []).length > 0,
    };
};

/** Past tense for a finished install, the receipt raised when it ends with nobody on the section. */
export const installedSentence = (name: string, verb: InstallVerb): string =>
    verb === `install` ? t(`sandbox.extensionsBrowse.installedName`, { name }) : t(`sandbox.extensionsBrowse.updatedName`, { name });

/**
 * An ended install said in the section's notice region, for when the listing's own dialog is not open to say it: since
 * a receipt nobody can see is how a finished install reads as a stuck one. Carries the run's key, so dismissing it puts
 * the run away; `reveal` opens the Installed pill on the extension.
 */
export const installNotice = (
    run: InstallRun,
    extensions: readonly ExtensionSummary[],
    reveal: (id: string | undefined) => void,
): NoticeModel | undefined => {
    if (run.state === `running`) {
        return undefined;
    }
    if (run.failure !== undefined) {
        return { ...run.failure, key: run.key };
    }
    const name = listingOf(run.key);
    const verb = run.value ?? `install`;
    const done = installOutcome(name, verb, extensions);
    const action = { label: t(`sandbox.discoverDetail.showInInstalled`), run: () => reveal(done.id) };
    if (done.problem === undefined) {
        return { tone: `info`, title: installedSentence(name, verb), action, key: run.key };
    }
    const title =
        verb === `install`
            ? t(`sandbox.extensionsBrowse.installedNotStartedName`, { name })
            : t(`sandbox.extensionsBrowse.updatedNotStartedName`, { name });
    return { tone: `warning`, title, detail: done.problem, action, key: run.key };
};
