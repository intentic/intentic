import { MAX_ELEMENTS } from "./page.js";

/* What the page is showing, as a list of things that can be acted on — the CDP half of it.
 *
 * THIS IS THE POINT OF THE PACKAGE. A screenshot tells a model where pixels are; this tells it what they MEAN:
 * that the grey rectangle is a button called "Send", that the box under it is a textbox currently holding
 * "invoice". Acting by reference then survives everything that breaks coordinates: a scroll, a resize, a
 * re-render, a different machine with a different screen.
 *
 * The refs are deliberately short-lived. They index an array parked on the page, and the next snapshot replaces
 * it, so a ref taken before a click that navigated cannot silently address whatever now sits in that slot. A
 * stale ref fails loudly, which is the behaviour worth having.
 *
 * The SHAPE this produces, and the rendering an agent reads it as, live in page.ts — shared with the browser
 * extension, which walks the DOM through Chrome's own APIs and must answer in the same language.
 *
 * The script below runs in the page, so it is written in plain ES5-ish JavaScript with no template literals: it
 * is embedded in a template literal here, and nesting them is how this kind of code acquires bugs that only
 * appear on somebody else's website. */

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
