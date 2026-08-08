import { analyzeCode, type CodeAnalysis } from "./codeAnalysis";
import type { CodeAnalysisRequest, CodeAnalysisResponse } from "./codeAnalysisProtocol";

export interface WorkerPort {
    postMessage(message: CodeAnalysisRequest): void;
    addEventListener(type: `message`, listener: (event: MessageEvent<CodeAnalysisResponse>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    terminate(): void;
}

interface CacheEntry {
    readonly text: string;
    readonly lang: string | undefined;
    readonly analysis: Promise<CodeAnalysis | undefined>;
}

type WorkerFactory = () => Promise<WorkerPort | undefined>;

// A review warms at most 60 sides. Four more entries let the file the reader opens immediately afterward join
// them without evicting the beginning of the review before it can be clicked.
const CACHE_LIMIT = 64;

/** A cached worker RPC client, with dependency injection for the protocol test and non-browser fallback. */
export const createCodeAnalysisClient = (workerFactory: WorkerFactory, local = analyzeCode) => {
    const cache: CacheEntry[] = [];
    const pending = new Map<number, { resolve: (analysis: CodeAnalysis | undefined) => void; reject: (error: Error) => void }>();
    let worker: Promise<WorkerPort | undefined> | undefined;
    let requestId = 0;

    const connect = (): Promise<WorkerPort | undefined> => {
        if (worker !== undefined) {
            return worker;
        }
        worker = workerFactory().then((port) => {
            port?.addEventListener(`message`, (event) => {
                const waiting = pending.get(event.data.id);
                if (waiting === undefined) {
                    return;
                }
                pending.delete(event.data.id);
                if (`error` in event.data) {
                    waiting.reject(new Error(event.data.error));
                    return;
                }
                waiting.resolve(event.data.analysis);
            });
            port?.addEventListener(`error`, (event) => {
                const error = event.error instanceof Error ? event.error : new Error(event.message || `Code analysis worker failed.`);
                for (const waiting of pending.values()) {
                    waiting.reject(error);
                }
                pending.clear();
                port.terminate();
                worker = undefined;
            });
            return port;
        });
        void worker.catch(() => (worker = undefined));
        return worker;
    };

    const run = async (text: string, lang: string | undefined): Promise<CodeAnalysis | undefined> => {
        const port = await connect().catch(() => undefined);
        if (port === undefined) {
            return local(text, lang);
        }
        const id = ++requestId;
        return new Promise<CodeAnalysis | undefined>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            port.postMessage({ id, text, lang });
        }).catch(() => local(text, lang));
    };

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

        const analysis = run(text, lang);
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
