// The knowledge engine's fs-free half, for callers with no filesystem behind them (the demo fixture) to get real
// index/graph/search answers rather than hand-authored ones. Kept out of the package's main entry, which the app
// bundles untree-shaken; read-notes.ts is excluded since it imports node:fs.
export { buildIndex, overviewOf, type BrokenLink, type NoteEdge, type KnowledgeIndex, type KnowledgeOverview } from "./index-notes.js";
export { parseNote, type NoteFile, type ParsedNote, factsOf } from "./note.js";
export { neighbourhood, search, type GraphView, type SearchFilters } from "./query.js";
export { starterNotes } from "./starter.js";
export { graphOf, hitsOf, noteOf, overviewFor, summaryOf } from "./wire.js";
