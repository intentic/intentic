import { MAX_ELEMENTS } from "./page.js";

// CDP half of page content as actionable refs; a ref indexes an array the next snapshot replaces, so a stale one
// fails loudly rather than silently retargeting. Shape and rendering live in page.ts, shared with the browser
// extension. Written without template literals since it's embedded in one here.

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
