import { WORKSPACE_ROOT } from "@intentic/constants";
import { pino } from "pino";

// The engine itself is a child process with ML models; what is under test is only what the daemon says of its progress.
const handed: { onIndexProgress?: (remaining: number) => void } = {};
jest.mock("@intentic/iq-engine/host", () => ({
    createEngineClient: (options: { onIndexProgress: (remaining: number) => void }) => {
        handed.onIndexProgress = options.onIndexProgress;
        return { pid: () => 1 };
    },
}));
jest.mock("../workload/workload-class.js", () => ({ applyWorkload: async () => {} }));

const { createCodeSearchEngine } = await import("./code-search.js");

const started = () => {
    const lines: { level: number; message: string; remaining?: number }[] = [];
    const logger = pino({ level: "debug", messageKey: "message" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    createCodeSearchEngine({ iqModelDir: "", iqRgPath: "" }, WORKSPACE_ROOT, logger);
    lines.length = 0;
    return { lines, progress: (remaining: number) => handed.onIndexProgress?.(remaining) };
};

afterEach(() => jest.useRealTimers());

// A save re-embeds a few dozen chunks in seconds: nothing anyone felt, so nothing above a trace.
test("a backlog that clears within its first interval is never an info line", () => {
    jest.useFakeTimers();
    const { lines, progress } = started();
    progress(64);
    jest.setSystemTime(Date.now() + 4_000);
    progress(0);
    expect(lines.map((line) => line.level)).toEqual([20, 20]);
});

test("a long rebuild names its load every interval and says when it is done", () => {
    jest.useFakeTimers();
    const { lines, progress } = started();
    progress(7124);
    for (const remaining of [5412, 3220, 1284]) {
        jest.setSystemTime(Date.now() + 31_000);
        progress(remaining);
    }
    jest.setSystemTime(Date.now() + 31_000);
    progress(0);
    expect(lines.filter((line) => line.level === 30).map((line) => [line.remaining, line.message])).toEqual([
        [5412, "iq index building embeddings: semantic search fills in as it goes"],
        [3220, "iq index building embeddings: semantic search fills in as it goes"],
        [1284, "iq index building embeddings: semantic search fills in as it goes"],
        [undefined, "iq index embeddings complete: semantic search at full coverage"],
    ]);
});
