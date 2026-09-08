// Assigning `style.textContent` tears down and rebuilds the stylesheet even when the bytes are identical, which
// resets any open DevTools Styles editor mid-edit. PrimeVue's `updated` hook and Vite's dev client both make such
// no-op writes routinely; this guards the element itself, dropping an assignment equal to the current value.

const stabilized = new WeakSet<HTMLStyleElement>();
// One observer per (document, selector); a second call for the same pair does not stack another listener.
const observers = new WeakMap<Document, Set<string>>();

/** Make identical `textContent` assignments on this one element a no-op. Idempotent. */
const stabilizeStyleElement = (style: HTMLStyleElement): void => {
    if (stabilized.has(style)) {
        return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, `textContent`);
    if (descriptor?.get === undefined || descriptor.set === undefined) {
        return;
    }
    stabilized.add(style);
    Object.defineProperty(style, `textContent`, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
            return descriptor.get!.call(this) as string | null;
        },
        set(value: string | null) {
            if (descriptor.get!.call(this) !== value) {
                descriptor.set!.call(this, value);
            }
        },
    });
};

const stabilizeStylesIn = (root: ParentNode, selector: string): void => {
    if (root instanceof HTMLStyleElement && root.matches(selector)) {
        stabilizeStyleElement(root);
    }
    root.querySelectorAll<HTMLStyleElement>(selector).forEach(stabilizeStyleElement);
};

/**
 * Holds every `<style>` matching `selector` stable against no-op writes: those already in `document.head`, and
 * any appended later (a lazy import, a hot update). Idempotent per selector.
 */
export const stabilizeStyleWrites = (selector: string): void => {
    if (typeof document === `undefined`) {
        return;
    }
    const watched = observers.get(document) ?? new Set<string>();
    observers.set(document, watched);
    if (watched.has(selector)) {
        return;
    }
    watched.add(selector);
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            record.addedNodes.forEach((node) => {
                if (node instanceof Element || node instanceof DocumentFragment) {
                    stabilizeStylesIn(node, selector);
                }
            });
        }
    });
    observer.observe(document.head, { childList: true });
    // Deferred to a microtask: the caller may install this during the sync work that inserts the first batch.
    queueMicrotask(() => stabilizeStylesIn(document.head, selector));
};
