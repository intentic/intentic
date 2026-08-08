export { activate } from "./extension.js";
export { manifest } from "./manifest.js";

/* THE WIRE, FOR WHOEVER HAS TO STAND IN FOR THE BACKEND.
 *
 * contract.ts says this wire is the extension's own and nobody else's, and that stays true for anyone
 * IMPLEMENTING it — the two halves are still the only ones that serve it. But the demo fixture has to ANSWER
 * these calls in a browser with no sandbox behind it, and a fixture that retyped the shapes by hand would be
 * one more copy to drift. It gets the namespace and the payload types from here, so a change to either shows
 * up as a demo that fails to compile rather than a demo panel that quietly 404s. */
export { MEMORY_BASE, type MemoryFile, type MemoryFileEntry } from "./contract.js";
