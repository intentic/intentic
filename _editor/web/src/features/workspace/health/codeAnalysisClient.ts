import type { CodeAnalysis } from "@intentic/code-read";
import { createWorkerCall, type WorkerFactory } from "../../../lib/workerCall";
import { analyzeInApp } from "../files/appGrammars";

export interface CodeAnalysisArgs {
    readonly text: string;
    readonly lang: string | undefined;
}

interface CacheEntry {
    readonly text: string;
    readonly lang: string | undefined;
    readonly analysis: Promise<CodeAnalysis | undefined>;
}

// A review warms at most 60 sides. Four more entries let the file the reader opens immediately afterward join
// them without evicting the beginning of the review before it can be clicked.
const CACHE_LIMIT = 64;

/** A cached worker RPC client, with dependency injection for the protocol test and non-browser fallback. */
export const createCodeAnalysisClient = (workerFactory: WorkerFactory<CodeAnalysisArgs, CodeAnalysis | undefined>, local = analyzeInApp) => {
    const cache: CacheEntry[] = [];
    const run = createWorkerCall(workerFactory, ({ text, lang }: CodeAnalysisArgs) => local(text, lang));

    return (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => {
        if (lang === undefined) {
            return Promise.resolve(undefined);
        }
        const hit = cache.findIndex((entry) => entry.text === text && entry.lang === lang);
        if (hit >= 0) {
            const [entry] = cache.splice(hit, 1);
            cache.push(entry!);
            return entry!.analysis;
        }

        const analysis = run({ text, lang });
        const entry = { text, lang, analysis };
        cache.push(entry);
        void analysis.catch(() => {
            const failed = cache.indexOf(entry);
            if (failed >= 0) {
                cache.splice(failed, 1);
            }
        });
        if (cache.length > CACHE_LIMIT) {
            cache.shift();
        }
        return analysis;
    };
};

export const requestCodeAnalysis = createCodeAnalysisClient(async () => {
    if (typeof Worker === `undefined`) {
        return undefined;
    }
    const { default: CodeAnalysisWorker } = await import(`./codeAnalysisWorker?worker`);
    return new CodeAnalysisWorker();
});
