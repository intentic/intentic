import { ref, type Ref, shallowRef, type ShallowRef } from "vue";

// Module state scoped to one sandbox (badge counts, poll results) that must survive a component unmount. Declare it
// through `sandboxRef`; the host clears it on every sandbox switch, so there is no subscription or teardown to write.

interface Registered {
    readonly clear: () => void;
}

const registered: Registered[] = [];

// Sandbox scope counter; this package can't see sandbox ids, only whether the scope changed since a value was captured.
let generation = 0;

// Enrols a box in the scope: every switch hands its outgoing value to `dispose`, then refills it from `initial()`.
const scoped = <T, B extends { value: T }>(box: B, initial: () => T, dispose?: (previous: T) => void): B => {
    registered.push({
        clear: () => {
            dispose?.(box.value);
            box.value = initial();
        },
    });
    return box;
};

// Module state scoped to one sandbox: resets to a fresh `initial()` on every switch. `dispose`, if given, runs once on
// the outgoing value, for state that owns something the garbage collector won't reclaim.
export const sandboxRef = <T>(initial: () => T, dispose?: (previous: T) => void): Ref<T> => scoped(ref(initial()) as Ref<T>, initial, dispose);

// `sandboxRef`'s lifetime with `shallowRef`'s reactivity, for a value replaced whole rather than edited in place (a
// map, an object with its own methods), which deep reactivity would proxy for nothing and hand back as another object.
export const sandboxShallowRef = <T>(initial: () => T, dispose?: (previous: T) => void): ShallowRef<T> =>
    scoped(shallowRef(initial()), initial, dispose);

// A sandbox-scoped box that nothing observes; same `.value` shape as a `Ref` so state can move between the two without
// changing call sites.
export interface SandboxValue<T> {
    value: T;
}

// Like `sandboxRef` but not reactive: safe to write from inside `detect()`/`badge()`, which run inside the host's own
// render computed, where writing a `Ref` would re-trigger it recursively.
export const sandboxValue = <T>(initial: () => T, dispose?: (previous: T) => void): SandboxValue<T> =>
    scoped<T, SandboxValue<T>>({ value: initial() }, initial, dispose);

// Snapshot the current scope before an await; call the result after to check the scope hasn't switched meanwhile.
// Needed because emptying the refs doesn't stop an in-flight request from writing its answer into the new scope.
export const sandboxScopeGuard = (): (() => boolean) => {
    const taken = generation;
    return () => taken === generation;
};

// Called by the shell whenever the active sandbox changes; extensions never call this, they have nothing to reset.
export const resetSandboxScope = (): void => {
    generation += 1;
    for (const entry of registered) {
        entry.clear();
    }
};
