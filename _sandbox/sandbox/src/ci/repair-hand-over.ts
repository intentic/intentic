import { extensionIdOf } from "@intentic/extension-manifest";
import type { CiRepairHandOver } from "@intentic/sandbox-contract/schemas/ci";
import { installedExtensions } from "../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../composition.js";
import { readAllExtensionSettings, writeExtensionSettings } from "../extensions/extension-settings.js";
import { recordExtensionConversation } from "../extensions/runtime/extension-conversations.js";

/* MAIN'S REPAIR, HANDED OVER (2026-11-26). Main's one fix agent left the daemon for the pipelines extension; what it kept
   here, in the CI store (ci-store.ts: every failing main line's streak, with its fix agent and the turns it was given,
   the passes, the fleet re-runs, the owner steps), is handed once to the extension that takes it over, which keeps it in
   its own documents from then on, and is dropped from the file in the same write. The fix agents named there become that
   extension's conversations, so it hears their runs end as it hears the ones it starts, and an owner who had switched
   repairs off in the sandbox's own setting has the extension's setting of the same name off too, written only where the
   extension declares that setting and holds no value of its own yet. A second call answers nothing, whoever asks. */

const AUTO_REPAIR = "autoRepair";

// Every conversation the handed-over state names: each streak's fix agents, and each agent that ended on an owner step.
const conversationsOf = (handed: Omit<CiRepairHandOver, "autoRepair">): readonly string[] => [
    ...new Set([
        ...Object.values(handed.failures).flatMap((failure) => failure.decisions.flatMap((decision) => (decision.conversationId === undefined ? [] : [decision.conversationId]))),
        ...Object.keys(handed.ownerSteps),
    ]),
];

// The owner's choice carried into the taking extension's own setting, when it declares one and has none stored.
const carryAutoRepairOff = async (services: Services, identity: string): Promise<void> => {
    const extension = (await installedExtensions(services)).find((candidate) => extensionIdOf(candidate.manifest) === identity);
    const declared = extension?.manifest.contributes?.settings ?? [];
    if (!declared.some((setting) => setting.key === AUTO_REPAIR)) {
        return;
    }
    const stored = (await readAllExtensionSettings(services.workspace.root, services.extensionSecretVault))[identity] ?? {};
    if (AUTO_REPAIR in stored) {
        return;
    }
    const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
    await writeExtensionSettings(services.workspace.root, services.extensionSecretVault, identity, { ...stored, [AUTO_REPAIR]: false }, secretKeys);
};

/** Hands main's repair state to the extension `identity` (publisher.name): the first call answers it, every later one
 *  answers it empty. */
export const handOverRepair = async (services: Services, identity: string, now: number = Date.now()): Promise<CiRepairHandOver> => {
    const handed = await services.ciStore.handOverRepair(identity, now);
    if (handed === undefined) {
        return { failures: {}, passes: {}, fleetReruns: {}, ownerSteps: {} };
    }
    for (const conversationId of conversationsOf(handed)) {
        await recordExtensionConversation(services.config.historyRoot, conversationId, identity, now);
    }
    if ((await services.sandboxSettings.get()).autoRepair) {
        return handed;
    }
    await carryAutoRepairOff(services, identity);
    services.logger.info({ extension: identity }, "ci repair: handed over with repairs off, as the owner had them");
    return { ...handed, autoRepair: false };
};
