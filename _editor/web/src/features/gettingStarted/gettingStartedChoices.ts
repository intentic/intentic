import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { computed, effectScope, type Ref, watch } from "vue";
import { activeSandboxId } from "../../lib/activeSandbox";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { type Choices, SKIPPABLE, STEP_IDS, type StepId } from "../tour/steps";

// What the reader said about the getting-started checklist on this sandbox: put away, steps passed over. Kept with the
// sandbox per member (`settings.gettingStarted`), so putting it away on the laptop takes it off the phone too, and one
// member's choice never touches a teammate's screen. A daemon older than that route keeps nothing: this browser keeps
// the choices then, per sandbox, which is as far as they can reach there.

const NONE: Choices = { hidden: false, skipped: [] };

const daemonKeeps = (): boolean => supportsRoute(`settings.gettingStarted`) && supportsRoute(`settings.setGettingStarted`);

const storageKey = (sandboxId: string | undefined): string => `intentic.gettingStarted.${sandboxId ?? `local`}`;

const isStep = (value: string): value is StepId => (STEP_IDS as readonly string[]).includes(value);

// Only what this editor knows how to draw: a step a later editor added and this one lacks is kept by the sandbox but
// not shown here.
const fromWire = (kept: { hidden?: boolean; skipped?: readonly string[] } | undefined): Choices => ({
    hidden: kept?.hidden === true,
    skipped: (kept?.skipped ?? []).filter(isStep).filter((id) => SKIPPABLE.has(id)),
});

const readStored = (sandboxId: string | undefined): Choices => {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(storageKey(sandboxId)) ?? `null`);
        return typeof raw === `object` && raw !== null ? fromWire(raw as { hidden?: boolean; skipped?: string[] }) : NONE;
        // allow(silent-catch): unreadable storage reads as nothing said, which is what a fresh browser would show.
    } catch {
        return NONE;
    }
};

const writeStored = (sandboxId: string | undefined, choices: Choices): void => {
    try {
        localStorage.setItem(storageKey(sandboxId), JSON.stringify(choices));
        // allow(silent-catch): a browser that refuses storage keeps the choice for this page load, in memory.
    } catch {}
};

// The choices as this window holds them: the sandbox's answer once heard, this browser's own until then (or always, on
// an older daemon). Written here first, so a press answers at once rather than after the round trip.
const choices: Ref<Choices> = sandboxRef(() => readStored(activeSandboxId.value));
// Whether the sandbox's answer has been heard, or there is none to hear: until then the checklist holds still.
const heard: Ref<boolean> = sandboxRef(() => false);

let started = false;

const start = (): void => {
    if (started) {
        return;
    }
    started = true;
    // Detached: the read lives as long as the window, not as long as whichever screen first drew the checklist.
    effectScope(true).run(() => {
        const { query } = useSandboxQuery({
            ...rpcQuery(`settings.gettingStarted`, undefined, { background: true }),
            enabled: computed(daemonKeeps),
        });
        watch(
            [() => query.data.value, () => query.isError.value, daemonKeeps],
            ([kept, failed, keeps]) => {
                if (!keeps || failed) {
                    // Nothing to wait for: this browser's own record is the answer.
                    heard.value = true;
                    return;
                }
                if (kept !== undefined) {
                    choices.value = fromWire(kept);
                    heard.value = true;
                }
            },
            { immediate: true },
        );
    });
};

const save = async (next: Choices): Promise<void> => {
    const sandboxId = activeSandboxId.value;
    choices.value = next;
    writeStored(sandboxId, next);
    if (!daemonKeeps()) {
        return;
    }
    const current = sandboxScopeGuard();
    try {
        const kept = await sandboxRpc.settings.setGettingStarted({ hidden: next.hidden, skipped: [...next.skipped] });
        if (current()) {
            choices.value = fromWire(kept);
        }
    } catch {
        // allow(silent-catch): a choice the sandbox could not take stands in this browser, which is where it was made.
    }
};

export const useGettingStartedChoices = () => {
    start();
    return {
        choices,
        heard,
        hide: () => save({ ...choices.value, hidden: true }),
        show: () => save({ ...choices.value, hidden: false }),
        skip: (step: StepId) => save({ ...choices.value, skipped: [...new Set([...choices.value.skipped, step])] }),
        unskip: (step: StepId) => save({ ...choices.value, skipped: choices.value.skipped.filter((id) => id !== step) }),
    };
};
