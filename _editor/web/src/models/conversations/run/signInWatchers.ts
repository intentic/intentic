import type { SignInCatcher } from "@intentic/sandbox-contract/schemas/loopback-catch";

// Who still watches a sign-in's landing, as each poll of the attempt says: a device whose link dropped or whose agent
// restarted no longer listens on the port, so the panel stops promising the sign-in finishes by itself (ConnectFlow's
// `watched` step) and asks for the address instead. Only ever narrows, and only the attempt it was read for; a daemon
// from before the field says nothing, and the list stands.
export const keepWatchers = <Flow extends { readonly catchers: readonly SignInCatcher[] }>(
    live: readonly SignInCatcher[] | undefined,
    flow: { value: Flow | undefined },
    same: (flow: Flow) => boolean,
): void => {
    const current = flow.value;
    if (live === undefined || current === undefined || !same(current)) {
        return;
    }
    const kept = current.catchers.filter((catcher) => live.some((one) => one.kind === catcher.kind && one.label === catcher.label));
    if (kept.length !== current.catchers.length) {
        flow.value = { ...current, catchers: kept };
    }
};
