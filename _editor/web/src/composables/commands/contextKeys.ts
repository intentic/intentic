import type { Disposable } from "@intentic/extension-api";
import type { WhenContext } from "@intentic/base/when";
import type { Ref } from "vue";
import { tabSurfaceOf } from "./tabSurface";

/* WHAT IS TRUE OF THE SHELL RIGHT NOW, as a bag of named values a condition can read.
 *
 * A command's `when` used to be a JavaScript closure, which made it powerful and unwritable: a predicate can
 * read any ref it can reach, and it can only exist in code this app was compiled with. An extension declares
 * its contributions in JSON, so extension commands could carry no condition at all, every one of them was
 * always in the palette and always bound. The keybindings page had the same problem from the other side: it
 * could see THAT a command was gated but never on what.
 *
 * A condition string over named keys fixes both, and the cost is this file: something has to publish the keys.
 * There are two kinds, and the difference is not cosmetic.
 *
 * PER-EVENT keys are facts about the keystroke itself, which panel the focus is in, whether the caret sits in
 * a field that owns its own undo. They cannot be published in advance because they differ for every keydown,
 * so they are computed at dispatch and merged over the published ones.
 *
 * PUBLISHED keys are facts about the app, is the sandbox reachable, is there anything to un-archive. A
 * surface publishes one for as long as it is mounted and takes it away with itself, which is what keeps a
 * condition naming it false rather than stale once the surface is gone.
 *
 * The published ones are held as the REFS THEMSELVES and read at dispatch, not copied into a bag when they
 * change. A watcher would have been the obvious shape and it is the wrong one: Vue flushes watchers on the
 * next tick, so a key set in the same task as the keystroke that reads it is still showing its old value,
 * a gate that opens one tick late is a chord that does nothing the first time it is pressed. Reading `.value`
 * at dispatch cannot be stale, and there is no watcher left to leak. */

const sources = new Map<string, Ref<unknown>>();

/* Publish a reactive value under a name conditions can read, for as long as the caller holds the returned
 * disposable. Surfaces already collect these alongside their `registerCommand` results and dispose the lot on
 * unmount, so a key's lifetime is the same as the commands that read it, which is the point: a board that
 * left `agentsUndoable` behind on unmount would leave Mod+Z claimed on a screen with no board on it. */
export const publishContextKey = (key: string, source: Ref<unknown>): Disposable => {
    if (sources.has(key)) {
        throw new Error(`context key "${key}" is already published`);
    }
    sources.set(key, source);
    return {
        dispose: (): void => {
            if (sources.get(key) === source) {
                sources.delete(key);
            }
        },
    };
};

/* A caret in a field that owns its own undo/selection. Per-event rather than published because it is a fact
 * about where the keystroke landed, and it lives here rather than in the one board that first needed it
 * because every editing chord wants the same exemption. */
const editableTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === `INPUT` || target.tagName === `TEXTAREA`);

/* The context one keydown is resolved against. Built ONCE per keystroke by `boundCommand` rather than per
 * candidate command: resolving the focused surface walks the DOM, and the registry holds dozens of gated
 * commands that the chord will not match anyway.
 *
 * Per-event keys are merged LAST so a published key can never shadow a fact about the keystroke, `tabSurface`
 * in particular has to be the focus's answer, always. */
export const commandContext = (event: KeyboardEvent): WhenContext => {
    const context: Record<string, unknown> = {};
    for (const [key, source] of sources) {
        context[key] = source.value;
    }
    context[`tabSurface`] = tabSurfaceOf(event);
    context[`editableTarget`] = editableTarget(event.target);
    return context;
};
