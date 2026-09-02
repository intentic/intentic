import { analyzeInApp } from "./appGrammars";
import type { CodeAnalysisRequest, CodeAnalysisResponse } from "./codeAnalysisProtocol";

/* oxlint-disable unicorn/require-post-message-target-origin -- dedicated-worker postMessage has no target origin */

/* Shiki/TextMate walks run here rather than on the browser's render thread. This worker owns its highlighter
 * core and lazily loaded grammars; the small serializable answer is all that crosses back to the UI. */
self.addEventListener(`message`, (event: MessageEvent<CodeAnalysisRequest>) => {
    const { id, text, lang } = event.data;
    void analyzeInApp(text, lang).then(
        (analysis) => self.postMessage({ id, analysis } satisfies CodeAnalysisResponse),
        (error: unknown) =>
            self.postMessage({ id, error: error instanceof Error ? error.message : `Code analysis failed.` } satisfies CodeAnalysisResponse),
    );
});
