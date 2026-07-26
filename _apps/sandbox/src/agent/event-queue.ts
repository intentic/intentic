/* An unbounded push/pull queue bridging concurrent producers into one async iteration. A turn's frames come
 * from several places at once — the SDK message pump, the permission gate's cards, an imp dispatch running
 * beside the architect — and every one of them is a plain callback, not a generator. Each pushes here; the
 * turn generator pulls. end() closes it, so a drained queue finishes iteration instead of blocking forever. */
export class EventQueue<T> implements AsyncIterable<T> {
    private readonly buffer: T[] = [];
    private ended = false;
    private wake: (() => void) | undefined;

    push(value: T): void {
        this.buffer.push(value);
        this.wake?.();
    }

    end(): void {
        this.ended = true;
        this.wake?.();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for (;;) {
            const next = this.buffer.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (this.ended) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
            this.wake = undefined;
        }
    }
}
