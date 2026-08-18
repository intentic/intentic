import { ref, type Ref } from "vue";

/* STATE THAT BELONGS TO ONE SANDBOX, and the reason an extension cannot be left to remember that itself.
 *
 * Three tiers of client state exist in this app, and each needs a different answer to "what happens on a
 * switch". Cached server state is keyed by `api.sandbox.key(...)`, so it is answered by construction. State
 * inside a mounted component dies with the component. THIS is the third tier: module state owned by
 * `activate()` — the badge counts, the document-presence maps, the poll results that must survive the view
 * being unmounted, because a badge you only see once you have already navigated to the view is pointless.
 *
 * Nothing owned it. A rail tile filled by a ten-minute timer therefore kept the PREVIOUS sandbox's number for
 * up to ten minutes after a switch, under the new sandbox's name — a badge is a claim addressed to the reader,
 * and one describing a workspace they are no longer looking at is worse than no badge at all. It was not one
 * extension's mistake either: every extension that badges had the identical shape, which is the signature of a
 * missing primitive rather than of carelessness.
 *
 * So the host owns it. Declare the state through `sandboxRef` and the host empties it on every switch; there
 * is no subscription to remember and no teardown to write.
 *
 * A MODULE-LEVEL REGISTRY IS CORRECT HERE, and that is worth saying because `hostSlot` in this same package
 * warns against exactly that. The shell publishes ONE instance of this module to every bundle
 * (extension-host/hostModules.ts), so a slot held here is shared by all of them — which made it wrong for a
 * per-extension host handle and makes it right for this: one switch empties every extension's scope, and no
 * extension can be missed. */

interface Registered {
    readonly clear: () => void;
}

const registered: Registered[] = [];

/* Which scope the extensions are in, counted rather than named — this module cannot see the sandbox id, and
 * does not need to. All any caller asks is "is this still the scope I started in", and a counter answers that
 * without this package having to know what a sandbox is. */
let generation = 0;

/* MODULE STATE FOR ONE SANDBOX. `initial` is a factory, not a value, so each scope starts from a fresh object
 * rather than sharing (and slowly mutating) one literal written at import time.
 *
 *     const unseen = sandboxRef<readonly ChoreVerdict[]>(() => []);
 *
 * It is an ordinary `Ref` in every other respect: read it in a `badge()` or a `detect()` and the host's own
 * computed re-renders the tile when it changes, exactly as before.
 *
 * `dispose` is for state that owns something the garbage collector will not take back — an object URL, a
 * subscription. It is handed the value being dropped, once, at the moment the scope closes. Most callers need
 * none: a list of verdicts is released by being replaced. */
export const sandboxRef = <T>(initial: () => T, dispose?: (previous: T) => void): Ref<T> => {
    const state = ref(initial()) as Ref<T>;
    registered.push({
        clear: () => {
            dispose?.(state.value);
            state.value = initial();
        },
    });
    return state;
};

/* THE GUARD FOR WORK THAT WAS ALREADY IN FLIGHT WHEN THE SWITCH HAPPENED.
 *
 * Emptying the refs is not enough on its own. A poll that issued its request under the old sandbox resolves a
 * moment after the switch, and writes the old box's answer into the fresh scope — the same wrong badge, just
 * harder to reproduce. There is no way for this module to cancel that request, so it offers the one thing the
 * caller needs instead: a way to ask, after the await, whether the answer is still wanted.
 *
 * Take it BEFORE the await, ask it AFTER:
 *
 *     const current = sandboxScopeGuard();
 *     const report = await api.sandbox.fetch(query);
 *     if (!current()) return;
 *     unseen.value = assess(report);
 *
 * Two lines, and the failure it prevents is invisible without them. */
export const sandboxScopeGuard = (): (() => boolean) => {
    const taken = generation;
    return () => taken === generation;
};

/* THE HOST'S DOOR, called by the shell when the active sandbox changes — not by extensions, which have nothing
 * to reset and no business resetting each other's. */
export const resetSandboxScope = (): void => {
    generation += 1;
    for (const entry of registered) {
        entry.clear();
    }
};
