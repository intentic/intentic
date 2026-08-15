import { twMerge } from "tailwind-merge";
import type { Directive } from "vue";

/* Applies conditional Tailwind classes with conflict resolution. Pass an array of class strings (falsy
 * entries ignored); tailwind-merge collapses conflicts so the last wins.
 *
 *   <div v-tw="[base, active && 'bg-card', !active && 'bg-canvas']"></div>
 */
type TwValue = (string | boolean | null | undefined)[] | undefined;

// Track the classes this directive last applied to each element, so an update removes only what it added
// (leaving unrelated classes intact). A WeakMap keyed by the element avoids mutating the DOM node.
const applied = new WeakMap<HTMLElement, string[]>();

const applyTw = (element: HTMLElement, value: TwValue): void => {
    const tokens = (value ?? []).filter((entry): entry is string => typeof entry === `string` && entry.length > 0);
    const next = twMerge(tokens.join(` `)).split(` `).filter(Boolean);
    const nextSet = new Set(next);

    for (const cls of applied.get(element) ?? []) {
        if (!nextSet.has(cls)) {
            element.classList.remove(cls);
        }
    }
    if (next.length > 0) {
        element.classList.add(...next);
    }
    applied.set(element, next);
};

export const vTw: Directive<HTMLElement, TwValue> = {
    mounted(element, binding) {
        applyTw(element, binding.value);
    },
    updated(element, binding) {
        applyTw(element, binding.value);
    },
};
