import { chunkFile } from "./chunker.js";
import { fileComplexity } from "./complexity.js";
import { extractImports } from "./imports.js";
import type { ParseFile } from "./indexer.js";
import { NON_CODE, parseLang } from "./languages.js";
import { extractSymbols } from "./symbols.js";

// The one extraction both hosts index with, the one-shot CLI engine on its own thread, and the daemon's index
// worker on its. They share a single on-disk index, so an index either one wrote has to be valid for the other:
// the moment these diverged, a file's chunks would flip between two shapes depending on which host last touched
// it, and PARSER_VERSION (which exists to make that kind of drift reindex) could not see it.
export const parseEntry: ParseFile = (path, lang, content) => {
    // Symbols and decision counts use the same immutable source tree. Vue's blocks are parsed by each extractor.
    const parsed = lang === undefined || NON_CODE.test(path) ? undefined : parseLang(lang, content)?.root();
    const symbols = extractSymbols(path, lang, content, parsed);
    return {
        symbols,
        chunks: chunkFile(path, symbols, content),
        complexity: fileComplexity(path, lang, content, parsed),
        imports: extractImports(path, lang, content),
    };
};
