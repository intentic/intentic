/* An unbounded push/pull queue bridging concurrent producers into one async iteration. */
export class EventQueue<T> implements AsyncIterable<T> {
    private readonly buffer: T[] = [];
    private state: "open" | "draining" | "ended" = "open";
    private wake: (() => void) | undefined;

    push(value: T): void {
        if (this.state === "ended") {
            return;
        }
        this.buffer.push(value);
        this.wake?.();
    }

    // Ends when the reader observes an empty buffer; late producers can still append while it drains.
    end(): void {
        if (this.state !== "ended") {
            this.state = "draining";
        }
        this.wake?.();
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for (;;) {
            if (this.buffer.length > 0) {
                // SAFETY: the length proves the slot exists; undefined itself can still be a T.
                yield this.buffer.shift() as T;
                continue;
            }
            if (this.state !== "open") {
                this.state = "ended";
                return;
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
            this.wake = undefined;
        }
    }
}
