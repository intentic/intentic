// Teardown as a store rather than a maintained list: what needs undoing registers at creation, so shutdown is one call
// that cannot skip anything. Disposal is never partial; a member that throws does not stop the rest, and failures
// surface together as one AggregateError.

export interface IDisposable {
    dispose(): void;
}

// Wraps anything with its own way to stop (`close()`, `stop()`, an unsubscribe function) as an `IDisposable`, so a
// store can hold it. A stop that returns a promise keeps returning it, which is what `disposeWithin` waits on.
export const toDisposable = (fn: () => unknown): IDisposable => ({ dispose: fn });

// How a deadline-bounded disposal ended: what threw or rejected, and how many asynchronous stops were still running
// when the deadline came.
export interface DisposeOutcome {
    readonly failed: readonly unknown[];
    readonly unfinished: number;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

const disposeAll = (disposables: Iterable<IDisposable>): void => {
    const errors: unknown[] = [];
    for (const disposable of disposables) {
        try {
            disposable.dispose();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 1) {
        throw errors[0];
    }
    if (errors.length > 1) {
        throw new AggregateError(errors, `${errors.length} disposables failed to dispose`);
    }
};

export class DisposableStore implements IDisposable {
    private readonly members = new Set<IDisposable>();
    private disposed = false;

    // Registering into an already-disposed store disposes the newcomer immediately instead of holding it: an async boot
    // step can land after shutdown began, and holding it would leak.
    add<T extends IDisposable>(disposable: T): T {
        if (this.disposed) {
            disposable.dispose();
            return disposable;
        }
        this.members.add(disposable);
        return disposable;
    }

    // For things that stop by being called; returns nothing, since `deleteAndDispose` already covers removal by
    // identity. Return the stop's promise rather than `void`ing it, so `disposeWithin` can wait for it.
    push(fn: () => unknown): void {
        this.add(toDisposable(fn));
    }

    // Releases one member early (a closed terminal, a watcher whose repo went away), so a long-lived store does not
    // grow forever.
    deleteAndDispose(disposable: IDisposable): void {
        if (this.members.delete(disposable)) {
            disposable.dispose();
        }
    }

    get size(): number {
        return this.members.size;
    }

    // Idempotent, and empties before disposing: a member whose `dispose()` reaches back into this store finds nothing
    // left to recurse into.
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const members = [...this.members];
        this.members.clear();
        disposeAll(members);
    }

    // A process's shutdown: members stop newest first, so what was built on top (a listener, a scheduler reading a
    // service) stops before what it was built on, and the door that admits new work closes before the work behind it
    // goes. Every stop is started in that order without waiting for the one before; the promises the asynchronous ones
    // return are then awaited together, for at most `deadlineMs`, so a stop that hangs cannot hold the exit. Never
    // throws: a failure is reported in the outcome, beside the count of stops still running at the deadline.
    async disposeWithin(deadlineMs: number): Promise<DisposeOutcome> {
        if (this.disposed) {
            return { failed: [], unfinished: 0 };
        }
        this.disposed = true;
        const members = [...this.members].toReversed();
        this.members.clear();
        const failed: unknown[] = [];
        const pending: Promise<void>[] = [];
        let unfinished = 0;
        for (const member of members) {
            try {
                const stopped: unknown = member.dispose();
                if (isThenable(stopped)) {
                    unfinished += 1;
                    pending.push(
                        Promise.resolve(stopped).then(
                            () => {
                                unfinished -= 1;
                            },
                            (error: unknown) => {
                                unfinished -= 1;
                                failed.push(error);
                            },
                        ),
                    );
                }
            } catch (error) {
                failed.push(error);
            }
        }
        if (pending.length > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, deadlineMs);
            });
            await Promise.race([Promise.all(pending), deadline]);
            clearTimeout(timer);
        }
        return { failed: [...failed], unfinished };
    }
}

// Base for a class that owns disposables via `this.register(...)`; a subclass overriding `dispose` must call
// `super.dispose()` last, so it can still reach its own members while stopping.
export abstract class Disposable implements IDisposable {
    protected readonly store = new DisposableStore();

    protected register<T extends IDisposable>(disposable: T): T {
        return this.store.add(disposable);
    }

    dispose(): void {
        this.store.dispose();
    }
}

// One slot holding at most one disposable; assigning a new value disposes the old one first, the shape of every
// "current X" field that would otherwise leak on reassignment.
export class MutableDisposable<T extends IDisposable> implements IDisposable {
    private current: T | undefined;
    private disposed = false;

    get value(): T | undefined {
        return this.current;
    }

    set value(next: T | undefined) {
        if (next === this.current) {
            return;
        }
        this.current?.dispose();
        this.current = this.disposed ? undefined : next;
        if (this.disposed) {
            next?.dispose();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.current?.dispose();
        this.current = undefined;
    }
}
