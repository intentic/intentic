export { activate } from "./extension.js";
export { manifest } from "./manifest.js";

/* THE WIRE, FOR WHOEVER HAS TO STAND IN FOR THE BACKEND, the demo fixture answers these calls in a browser with no sandbox behind it. */
export { KNOWLEDGE_BASE, type Graph, type Note, type NoteLink, type NoteSummary, type Overview, type SearchHit } from "./contract.js";
