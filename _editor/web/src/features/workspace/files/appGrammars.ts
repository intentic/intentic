import { analyzeCode, type CodeAnalysis, type Grammars } from "@intentic/code-read";
import { useHighlighter } from "@intentic/ui/highlighter";

/* WHERE THIS APP'S CODE READING GETS ITS GRAMMARS: the very core Shiki has already built to COLOUR files. */
const grammars: Grammars = async (lang) => (await useHighlighter().ensureLang(lang))?.getLanguage(lang);

/** The whole reading of one side, on this thread. */
export const analyzeInApp = (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => analyzeCode(text, lang, grammars);
