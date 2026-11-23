import { onScopeDispose, ref, watch } from "vue";

// THE SANDBOXES THIS WINDOW IS SETTING UP, by id, from the moment a row exists until its first check-in has been counted
// (features/setup/flow/useSetupRow.ts). Read by product analytics' sandbox gate (features/sandbox/analytics/analyticsGate.ts):
// the gate holds every event back while the open sandbox's own analytics switch is unread, and a sandbox being set up
// cannot be read (its daemon is not up yet), while it is also the open one as soon as it is in the list (useSandbox.ts
// `reconcileActive` picks a first sandbox by itself). So every setup milestone after the press was dropped: from
// 2026-10-13, when the gate landed, `sandbox_hosted_created` fired zero times and `sandbox_connected` about once a week,
// though machines were made and sandboxes connected every day (PostHog, 2026-11-23). Nobody has opened a sandbox still
// being set up, so nobody can have switched its analytics off: its switch is the default, which allows.

// allow(module-state): one window's own setups, shared by the setup row that marks them and the gate that reads them
const ids = ref<ReadonlySet<string>>(new Set());

/** A row this window is setting up now. */
export const markSettingUp = (sandboxId: string): void => {
    if (!ids.value.has(sandboxId)) {
        ids.value = new Set([...ids.value, sandboxId]);
    }
};

/** Set up (its check-in counted), or given up. */
export const doneSettingUp = (sandboxId: string): void => {
    if (ids.value.has(sandboxId)) {
        ids.value = new Set([...ids.value].filter((id) => id !== sandboxId));
    }
};

/** Whether this window is setting the sandbox up. Reactive. */
export const settingUp = (sandboxId: string): boolean => ids.value.has(sandboxId);

/** Marks whichever row `current` names for as long as it names it, in the calling scope; none once the scope ends. */
export const followSettingUp = (current: () => string | undefined): void => {
    watch(
        current,
        (id, previous) => {
            if (previous !== undefined && previous !== id) {
                doneSettingUp(previous);
            }
            if (id !== undefined) {
                markSettingUp(id);
            }
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        const id = current();
        if (id !== undefined) {
            doneSettingUp(id);
        }
    });
};
