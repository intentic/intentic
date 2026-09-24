import { serveWorkerCall } from "../../../lib/workerCall";
import { analyzeInApp } from "../files/appGrammars";
import type { CodeAnalysisArgs } from "./codeAnalysisClient";

/* Shiki/TextMate walks run here rather than on the browser's render thread. */
serveWorkerCall(({ text, lang }: CodeAnalysisArgs) => analyzeInApp(text, lang));
