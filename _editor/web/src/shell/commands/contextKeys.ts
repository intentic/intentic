import type { Disposable } from "@intentic/extension-api";
import type { WhenContext } from "@intentic/base/when";
import type { Ref } from "vue";
import { tabSurfaceOf } from "./tabSurface";

// Named values a command's `when` condition can read. Per-event keys (focused panel, editable caret)
// are computed fresh at dispatch; published keys are app facts, live only while their surface is mounted.
// Published refs are read directly at dispatch, not copied via a watcher, which would lag by one tick.

const sources = new Map<string, Ref<unknown>>();

// Publishes a reactive value under a name conditions can read, live until the returned disposable is
// called. Tie its lifetime to the surface's commands, or a chord stays claimed after the surface is gone.
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

// Whether the caret is in a field with its own undo/selection. Per-event, not published: every
// editing chord needs the same exemption on where the keystroke landed.
const editableTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === `INPUT` || target.tagName === `TEXTAREA`);

// Built once per keystroke, not per candidate command, since resolving focus walks the DOM. Per-event
// keys are merged last, so a published key can never shadow the keystroke's own facts (tabSurface especially).
export const commandContext = (event: KeyboardEvent): WhenContext => {
    const context: Record<string, unknown> = {};
    for (const [key, source] of sources) {
        context[key] = source.value;
    }
    context[`tabSurface`] = tabSurfaceOf(event);
    context[`editableTarget`] = editableTarget(event.target);
    return context;
};
