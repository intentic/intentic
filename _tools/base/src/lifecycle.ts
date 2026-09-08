// Teardown as a store rather than a maintained list: what needs undoing registers at creation, so shutdown is one call
// that cannot skip anything. Disposal is never partial; a member that throws does not stop the rest, and failures
// surface together as one AggregateError.

export interface IDisposable {
    dispose(): void;
}

// Wraps anything with its own way to stop (`close()`, `stop()`, an unsubscribe function) as an `IDisposable`, so a
// store can hold it.
export const toDisposable = (fn: () => void): IDisposable => ({ dispose: fn });

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
    // identity.
    push(fn: () => void): void {
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
