/* THE KNOWLEDGE ENGINE AS A SECOND ENTRY POINT — everything in this directory that touches no filesystem.
 *
 * It exists for the callers that have to ANSWER for a knowledge base without one behind them: the demo fixture, which
 * serves this extension's namespace in a browser with no sandbox at all. That fixture could have hand-authored
 * its backlinks, its graph and its counts, and would then be a second implementation of the interesting half of
 * this extension — showing visitors behaviour the product does not actually have. Instead it builds a real
 * index over real note text and gets the real answers.
 *
 * Kept OUT of the package's main entry deliberately. The app bundles that entry as a namespace object it cannot
 * tree-shake, so anything exported there is shipped to every browser whether or not a knowledge base is ever opened; the
 * engine belongs to the two halves that run it and to whoever stands in for them, not to the shell.
 *
 * read-notes.ts is absent for the opposite reason: it imports node:fs, and nothing here may. */
export { buildIndex, overviewOf, type BrokenLink, type NoteEdge, type KnowledgeIndex, type KnowledgeOverview } from "./index-notes.js";
export { parseNote, type NoteFile, type ParsedNote, factsOf } from "./note.js";
export { neighbourhood, search, type GraphView, type SearchFilters } from "./query.js";
export { starterNotes } from "./starter.js";
export { graphOf, hitsOf, noteOf, overviewFor, summaryOf } from "./wire.js";
