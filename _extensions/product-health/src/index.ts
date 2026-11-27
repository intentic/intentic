export { activate } from "./extension.js";
export { manifest } from "./manifest.js";
// Read by the host before it calls `activate`, so the labels registered there are already in the reader's language.
export { messages } from "./i18n.js";
