/* An unbounded push/pull queue bridging concurrent producers into one async iteration. */
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
