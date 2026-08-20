export { activate } from "./extension.js";
export { manifest } from "./manifest.js";

/* THE WIRE, FOR WHOEVER HAS TO STAND IN FOR THE BACKEND, the demo fixture answers these calls in a browser
 * with no sandbox behind it, and a fixture that retyped the shapes by hand would be one more copy to drift. It
 * takes the namespace and the payload types from here, so a change to either shows up as a demo that fails to
 * compile rather than a demo panel that quietly 404s. */
export { KNOWLEDGE_BASE, type Graph, type Note, type NoteLink, type NoteSummary, type Overview, type SearchHit } from "./contract.js";
