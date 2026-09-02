/* HOW THE PRODUCT READS SOURCE CODE, in one place, because two readings of the same file that disagree are
 * worse than either of them alone.
 *
 * A changed file is read twice in this product, on two sides of the wire, and both readings come from here:
 *
 *   - the DAEMON counts it, once, when it builds a change list: the code-only +/− every review row shows is
 *     computed there (git/code-counts.ts) so the number is final the first time the reader sees it, rather than
 *     arriving later and moving the row it is on;
 *   - the APP renders it: the diff surface strips the comments out of both sides before Monaco ever sees them
 *     (useDiffStat, DiffView), and lands the diff below the imports (codeLanding).
 *
 * The two must agree to the line, or the badge on a row describes a diff the pane is not showing. They agree
 * because it is the same walk (tokens.ts), over the same grammar table (langs.ts), resolved from the path by the
 * same rule (lang-for-path.ts) — the only thing either side supplies is WHERE the grammar comes from, since the
 * app already has Shiki loaded to colour the file and the daemon has to load its own (grammars.ts). */

export { analyzeCode, modelLineOf, type CodeAnalysis, type CodeSide } from "./analysis.js";
export { codeLangForPath, highlightLangFor, langFor, langFromShebang, nameExt, HIGHLIGHT_MAX_BYTES } from "./lang-for-path.js";
export { codeLineStat, lineStat, type Analyze, type LineStat } from "./stat.js";
export { isBlank, leadToken, scopedAs, walkTokens, type Grammars, type Token } from "./tokens.js";
