import { describe, expect, it, vi } from "vitest";
import type { CodeAnalysis } from "@intentic/code-read";
import { createCodeAnalysisClient, type WorkerPort } from "./codeAnalysisClient";
import type { CodeAnalysisRequest, CodeAnalysisResponse } from "./codeAnalysisProtocol";

class FakeWorker implements WorkerPort {
    readonly sent: CodeAnalysisRequest[] = [];
    terminated = false;
    private message?: (event: MessageEvent<CodeAnalysisResponse>) => void;

    postMessage(message: CodeAnalysisRequest): void {
        this.sent.push(message);
    }

    addEventListener(type: `message`, listener: (event: MessageEvent<CodeAnalysisResponse>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    addEventListener(
        type: `message` | `error`,
        listener: ((event: MessageEvent<CodeAnalysisResponse>) => void) | ((event: ErrorEvent) => void),
    ): void {
        if (type === `message`) {
            this.message = listener as (event: MessageEvent<CodeAnalysisResponse>) => void;
        }
    }

    respond(response: CodeAnalysisResponse): void {
        this.message?.({ data: response } as MessageEvent<CodeAnalysisResponse>);
    }

    terminate(): void {
        this.terminated = true;
    }
}

describe(`code analysis worker client`, () => {
    it(`coalesces the same text and language, then keeps the settled analysis warm`, async () => {
        const worker = new FakeWorker();
        const local = vi.fn();
        const analyze = createCodeAnalysisClient(async () => worker, local);
        const expected: CodeAnalysis = { code: { text: `const a = 1;`, lines: [2] }, imports: [] };

        const first = analyze(`// note\nconst a = 1;`, `typescript`);
        const concurrent = analyze(`// note\nconst a = 1;`, `typescript`);
        expect(concurrent).toBe(first);
        await vi.waitFor(() => expect(worker.sent).toHaveLength(1));

        worker.respond({ id: worker.sent[0]!.id, analysis: expected });
        await expect(first).resolves.toEqual(expected);
        await expect(analyze(`// note\nconst a = 1;`, `typescript`)).resolves.toEqual(expected);
        expect(worker.sent).toHaveLength(1);
        expect(local).not.toHaveBeenCalled();
    });

    it(`uses the local analyzer when workers are unavailable`, async () => {
        const expected: CodeAnalysis = { code: { text: `a`, lines: [1] }, imports: [] };
        const local = vi.fn(async () => expected);
        const analyze = createCodeAnalysisClient(async () => undefined, local);

        await expect(analyze(`a`, `typescript`)).resolves.toEqual(expected);
        expect(local).toHaveBeenCalledOnce();
    });
});
