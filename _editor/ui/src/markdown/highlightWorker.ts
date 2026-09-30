// The markdown engine's syntax highlighter, run in a worker (code.ts `highlightInWorker`): the same Shiki core, the same
// grammars and the same sliced highlight, answering with the same HTML, off the page's main thread. A grammar's first
// use compiles every regex it holds into a JavaScript one, which for TypeScript was three quarters of a second of a
// frozen chat at 4× CPU throttle; here a phone's page keeps answering taps while it happens.
import { useHighlighter } from "../composables/useHighlighter.js";
import { serveWorkerCall } from "../lib/workerCall.js";

const { highlightSliced } = useHighlighter();

serveWorkerCall(({ code, lang }: { readonly code: string; readonly lang: string }) => highlightSliced(code, lang, { from: `start`, stale: () => false }));
