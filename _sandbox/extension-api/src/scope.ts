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
 * computed re-renders the tile when it changes, exactly as before. READ, not write — see `sandboxValue`.
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

// A sandbox-scoped box that nothing observes. Same shape as a `Ref` on purpose — `.value`, read and written —
// so moving state between the two is one word at the declaration and nothing at the call sites.
export interface SandboxValue<T> {
    value: T;
}

/* MODULE STATE FOR ONE SANDBOX THAT NOTHING RENDERS — `sandboxRef`'s lifetime without its reactivity, for the
 * bookkeeping a background poll keeps for ITSELF: which connections to ask about next round, the cursor a
 * fetch resumes from, the id a retry belongs to.
 *
 * It exists because of where `detect()` and `badge()` are called from. Both run INSIDE the host's render
 * computed — that is the whole mechanism by which a tile repaints when a poll lands — and a `Ref` WRITTEN from
 * inside a computed is that computed mutating its own dependency. Vue re-runs it, the write happens again, and
 * the rail recurses until Vue abandons the flush mid-frame. What the reader sees then is not one broken tile:
 * every update queued behind the rail is dropped with the flush, so the whole window stops answering, and the
 * console fills with a recursion error naming a component that is merely where the loop was noticed.
 *
 * So the division is by AUDIENCE, not by lifetime: `sandboxRef` for what a tile SHOWS, `sandboxValue` for what
 * a poll REMEMBERS. Both are emptied on a switch by the same door, and writing this one from a render callback
 * is safe precisely because there is nothing to invalidate. When a poll's own bookkeeping later turns out to
 * be worth showing, promoting it is a one-word change — and the promotion is the moment to check that nothing
 * writes it from `detect()`.
 *
 * `dispose` behaves exactly as it does on `sandboxRef`. */
export const sandboxValue = <T>(initial: () => T, dispose?: (previous: T) => void): SandboxValue<T> => {
    const box: SandboxValue<T> = { value: initial() };
    registered.push({
        clear: () => {
            dispose?.(box.value);
            box.value = initial();
        },
    });
    return box;
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
