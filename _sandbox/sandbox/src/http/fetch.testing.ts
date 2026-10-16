// Fetch answers for the daemon's suites. `streamedResponse` mirrors @intentic/base's own test helper
// (_tools/base/src/web/capped-read.testing.ts), which the package does not export.

// A chunked answer with no Content-Length, for every suite whose code must refuse an oversized body: `chunks` pieces
// of `size` bytes each, counting how many were pulled, so a test can tell a reader that stopped at its cap from one
// that drained the stream and measured it afterwards.
export const streamedResponse = (chunks: number, size: number, fill = 0x61, init?: ResponseInit) => {
    const pulled = { count: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulled.count >= chunks) {
                controller.close();
                return;
            }
            pulled.count += 1;
            controller.enqueue(new Uint8Array(size).fill(fill));
        },
        cancel() {
            pulled.cancelled = true;
        },
    });
    return { response: new Response(body, init), pulled };
};

// A fetch that answers its n-th request (counting from 1) with what `answer` returns for n: typed as fetch itself, so
// the code under test takes it where it takes the real one.
export const answeringFetch = (answer: (call: number) => Response): typeof fetch => {
    let call = 0;
    return Object.assign(
        async () => {
            call += 1;
            return answer(call);
        },
        { preconnect: fetch.preconnect },
    );
};

// A connection that never answers: the request waits until its signal aborts, then rejects with the signal's reason,
// as fetch does. A request sent with no deadline at all is rejected at once, naming that, so a test can't wait out
// the hang detector instead. Pair it with `expireTimeouts()` to see the deadline pass without waiting it out.
export const stalledFetch: typeof fetch = Object.assign(
    (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === undefined || signal === null) {
                reject(new Error("stalledFetch: the request carried no deadline"));
                return;
            }
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    { preconnect: fetch.preconnect },
);

// Every `AbortSignal.timeout(ms)` comes back already expired, as its deadline passing would leave it; `asked` lists
// each ms requested. Restore with the returned spy's `mockRestore()`.
export interface ExpiredTimeouts {
    readonly asked: number[];
    readonly mockRestore: () => void;
}

export const expireTimeouts = (): ExpiredTimeouts => {
    const asked: number[] = [];
    const spy = jest.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        asked.push(ms);
        return AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    });
    return { asked, mockRestore: () => spy.mockRestore() };
};

