import type { PageElement, PageState } from "./types.js";

/* What the page is showing, as a list of things that can be acted on.
 *
 * THIS IS THE POINT OF THE PACKAGE. A screenshot tells a model where pixels are; this tells it what they MEAN,
 * that the grey rectangle is a button called "Send", that the box under it is a textbox currently holding
 * "invoice". Acting by reference then survives everything that breaks coordinates: a scroll, a resize, a
 * re-render, a different machine with a different screen.
 *
 * The refs are deliberately short-lived. They index an array parked on the page, and the next snapshot replaces
 * it, so a ref taken before a click that navigated cannot silently address whatever now sits in that slot. A
 * stale ref fails loudly, which is the behaviour worth having.
 *
 * The script below runs in the page, so it is written in plain ES5-ish JavaScript with no template literals: it
 * is embedded in a template literal here, and nesting them is how this kind of code acquires bugs that only
 * appear on somebody else's website. */

// Beyond this the list is more noise than help, a search-results page can hold thousands of links, and a model
// reading two hundred of them has already lost the thread. Truncation is reported so it is never silent.
const MAX_ELEMENTS = 150;

export const SNAPSHOT_SCRIPT = `(function () {
  var MAX = ${MAX_ELEMENTS};
  var refs = [];
  window.__intenticRefs = refs;

  function visible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'element';
  }

  function nameOf(el) {
    var candidates = [
      el.getAttribute('aria-label'),
      el.getAttribute('alt'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      (el.innerText || '').trim(),
      el.value
    ];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim().replace(/\\s+/g, ' ').slice(0, 120);
      }
    }
    return '';
  }

  var selector = 'a[href], button, input, textarea, select, summary, [role], [onclick], [contenteditable=""], [contenteditable="true"], h1, h2, h3';
  var found = document.querySelectorAll(selector);
  var elements = [];
  for (var i = 0; i < found.length && elements.length < MAX; i++) {
    var el = found[i];
    if (!visible(el)) continue;
    var role = roleOf(el);
    var name = nameOf(el);
    // A nameless non-input is something a caller could never ask for by name, so it is noise.
    if (name === '' && role !== 'textbox' && role !== 'checkbox' && role !== 'file') continue;
    var ref = 'e' + refs.length;
    refs.push(el);
    var entry = { ref: ref, role: role, name: name };
    if (typeof el.value === 'string' && el.value !== '' && role !== 'button') entry.value = el.value.slice(0, 120);
    if (role === 'checkbox' || role === 'radio') entry.value = el.checked ? 'checked' : 'unchecked';
    elements.push(entry);
  }
  return {
    url: location.href,
    title: document.title,
    truncated: found.length > 0 && elements.length >= MAX,
    elements: elements
  };
})()`;

/* The agent-facing rendering. One line per element, the ref first because that is what gets passed back, then
 * what it is and what it says, the shape a person scanning for "the Send button" reads fastest.
 *
 * Pure, and therefore the part of this package that can be tested without a browser. */
export const renderPage = (page: PageState, truncated = false): string => {
    const header = [`Page: ${page.title === "" ? "(untitled)" : page.title}`, page.url];
    if (page.elements.length === 0) {
        return [...header, "", "Nothing on this page can be clicked or typed into: try reading its text instead."].join("\n");
    }
    const rows = page.elements.map((element) => {
        const said = element.name === "" ? "" : ` "${element.name}"`;
        const holds = element.value === undefined || element.value === "" ? "" : ` = "${element.value}"`;
        return `[${element.ref}] ${element.role}${said}${holds}`;
    });
    const note = truncated ? [`(only the first ${MAX_ELEMENTS} are listed, scroll or narrow the page to see more)`] : [];
    return [...header, "", ...rows, ...note].join("\n");
};

// The snapshot script's own shape, as it comes back from Runtime.evaluate.
export interface RawSnapshot {
    readonly url?: string;
    readonly title?: string;
    readonly truncated?: boolean;
    readonly elements?: readonly PageElement[];
}

export const toPageState = (raw: RawSnapshot): PageState => ({
    url: raw.url ?? "",
    title: raw.title ?? "",
    elements: raw.elements ?? [],
});

// Which slot in the page's ref array a reference names. Rejects anything that is not one of ours, so a model
// improvising a CSS selector gets a clear refusal rather than a mysterious no-op.
export const refIndex = (ref: string): number => {
    const match = /^e(\d+)$/.exec(ref.trim());
    return match?.[1] === undefined ? -1 : Number(match[1]);
};
