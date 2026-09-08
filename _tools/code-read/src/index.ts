// Source is read the same way on both sides of the wire here: the daemon's change counts and the app's diff view share
// this grammar resolution, token walk, and line counting so they cannot disagree.

export { analyzeCode, modelLineOf, type CodeAnalysis, type CodeSide } from "./analysis.js";
export { codeLangForPath, highlightLangFor, langFor, langFromShebang, nameExt, HIGHLIGHT_MAX_BYTES } from "./lang-for-path.js";
export { codeLineStat, lineStat, type Analyze, type LineStat } from "./stat.js";
export { isBlank, leadToken, scopedAs, walkTokens, type Grammars, type Token } from "./tokens.js";
