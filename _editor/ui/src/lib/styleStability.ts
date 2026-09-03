/* AN IDENTICAL STYLESHEET WRITE IS NOT A NO-OP TO THE BROWSER, AND THAT IS THE WHOLE PROBLEM.
 *
 * Assigning `style.textContent` replaces the element's text node whether or not a single byte differs, and
 * Chrome answers that by tearing the stylesheet down and building a new one: the document repaints, and every
 * client of the old sheet loses its handle on it. With DevTools open that client is the Styles editor, which
 * rebuilds from scratch — closing the colour picker mid-drag, which is how this is actually met ("I open the
 * picker, the CSS flickers, I start again").
 *
 * TWO WRITERS IN THIS APP MAKE IDENTICAL ASSIGNMENTS AS A MATTER OF COURSE, and neither can be told not to:
 *
 *   · PrimeVue reloads its directive styles from every `updated` hook, so ordinary request state (a loading
 *     label, a disabled button, a notification) rewrites the same bytes over and over.
 *   · Vite's dev client re-pushes the Tailwind-generated stylesheet whenever ANY scanned source file changes
 *     — Tailwind registers each one as a watch dependency of styles.css — and a code edit almost never moves a
 *     utility, so what arrives is the ~900 KB sheet the page already has, byte for byte (client.mjs's
 *     `updateStyle` ends in a bare `style.textContent = content`).
 *
 * So the guard goes on the ELEMENT, where both writers meet: an assignment equal to what is already there is
 * dropped, anything else is passed straight through. A genuinely changed preset, a real CSS edit and a new
 * component's first stylesheet all behave exactly as before; only the writes that were never going to change
 * anything stop costing a repaint.
 */

const stabilized = new WeakSet<HTMLStyleElement>();
// One observer per (document, selector): a second call for the same pair must not stack another listener, and
// two different selectors in one document are two independent watches.
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

/** Hold every `<style>` matching `selector` — those in `document.head` now, and those a later import,
 *  lazy view or hot update appends — stable against writes that change nothing. Idempotent per selector. */
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
    /* The sweep covers what is already there, the observer what arrives next. A microtask rather than a call
     * here, because the caller may be installing this DURING the synchronous work that inserts the first
     * batch (PrimeVue's plugin does exactly that, inside `app.use`). */
    queueMicrotask(() => stabilizeStylesIn(document.head, selector));
};
