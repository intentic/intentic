// Work that runs a few at a time. Past `atOnce` running, the next waits its turn in order; past `waiting` waiting, the
// caller is told it is full rather than handed a queue without end. For work that cannot be stopped once it starts (a
// document reader), which is how long it holds the machine is bounded by how many run at once.
export class Turns {
    #running = 0;
    readonly #queue: (() => void)[] = [];

    constructor(
        private readonly atOnce: number,
        private readonly waiting: number,
    ) {}

    // Whether one more task would be turned away rather than wait.
    full(): boolean {
        return this.#running >= this.atOnce && this.#queue.length >= this.waiting;
    }

    // Runs `task` once a turn is free. A turn a task ends, however it ends, goes to the next one waiting.
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.#running < this.atOnce) {
            this.#running++;
        } else {
            await new Promise<void>((resolve) => this.#queue.push(resolve));
        }
        try {
            return await task();
        } finally {
            const next = this.#queue.shift();
            if (next === undefined) {
                this.#running--;
            } else {
                next();
            }
        }
    }
}
