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
