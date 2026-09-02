import { analyzeCode, type CodeAnalysis, type Grammars } from "@intentic/code-read";
import { useHighlighter } from "@intentic/ui/highlighter";

/* WHERE THIS APP'S CODE READING GETS ITS GRAMMARS: the very core Shiki has already built to COLOUR files.
 *
 * The reading itself is shared with the daemon (@intentic/code-read) and takes its grammars from whoever calls
 * it, which is the seam this file fills on the browser side. Sharing the renderer's core rather than building a
 * second one is not a micro-optimisation: a grammar is compiled per language per thread the first time a line
 * reaches each of its rules (see useHighlighter's warm-up), so a second core would pay that again for every
 * language a review touches, and hold a second copy of each. */
const grammars: Grammars = async (lang) => (await useHighlighter().ensureLang(lang))?.getLanguage(lang);

/** The whole reading of one side, on this thread. The worker runs the same call; everything else goes through
 *  the client (codeAnalysisClient), which is this with a cache and a worker in front of it. */
export const analyzeInApp = (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => analyzeCode(text, lang, grammars);
