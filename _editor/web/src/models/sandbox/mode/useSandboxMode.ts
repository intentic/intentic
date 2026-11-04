import { handsOffChanges, type ManagedRule, type SandboxMode } from "@intentic/sandbox-contract/schemas/sandbox-mode";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { refreshSandboxWords } from "../../../client/sandbox/audienceSync";
import { useSandboxSettings } from "../useSandboxSettings";

// HOW THE ACTIVE SANDBOX RUNS (settings `mode`, @intentic/constants sandbox-mode.ts), read and switched over the same
// settings object every other setting rides. Switching is a settings write, so maintainer and up at the daemon; the
// daemon's store then keeps the land, version and back-up rules standing while the sandbox runs hands-off, and the words
// of everyone who follows the sandbox change with it, which is why a switch reads the words again.

// What a switch would change, said under the pick before it is saved: each rule the sandbox would take over, in the
// order they act, and who reads plain words. Going back to hands-on changes nothing at once, which is said as well, so
// the press never reads as losing something.
const TAKES_OVER: Readonly<Record<ManagedRule, () => string>> = {
    land: () => t(`sandbox.mode.preview.land`),
    version: () => t(`sandbox.mode.preview.version`),
    push: () => t(`sandbox.mode.preview.push`),
};

export const modeSwitchLines = (from: SandboxMode, to: SandboxMode, rules: readonly Rule[]): string[] => {
    if (from === to) {
        return [];
    }
    if (to === `hands-on`) {
        return [t(`sandbox.mode.preview.handsOn`)];
    }
    const changes = handsOffChanges(rules);
    const taken = changes.length === 0 ? [t(`sandbox.mode.preview.alreadyOn`)] : changes.map((which) => TAKES_OVER[which]());
    return [...taken, t(`sandbox.mode.preview.words`)];
};

export function useSandboxMode() {
    const { settings, save, refusal } = useSandboxSettings();

    // Undefined until the settings are read, and on a daemon whose settings predate the mode, which would drop it.
    const mode = computed<SandboxMode | undefined>(() => settings.value?.mode);

    // Whether the switch was kept; a refusal is `refusal`, in the daemon's words, for the editor that pressed it.
    const switchTo = async (next: SandboxMode): Promise<boolean> => {
        const current = settings.value;
        if (current === undefined) {
            return false;
        }
        try {
            await save.mutateAsync({ ...current, mode: next });
        } catch {
            // allow(silent-catch): the refusal is on `refusal`, which the editor that pressed it shows beside its Save.
            return false;
        }
        await refreshSandboxWords();
        return true;
    };

    return { mode, settings, switchTo, saving: save.isPending, refusal };
}
