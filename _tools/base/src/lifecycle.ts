/* TEARDOWN AS STRUCTURE RATHER THAN AS A LIST SOMEBODY MAINTAINS.
 *
 * The daemon's shutdown was, for a long time, twenty-five `.stop()` calls in a row at the bottom of main.ts.
 * Nothing connected that list to the subsystems it was supposed to cover: adding a watcher, a poller or a
 * timer meant remembering to add a line, and forgetting cost nothing visible — the process was exiting anyway,
 * so a missed stop showed up only where it hurts, in the tests and the long-lived dev sandbox, as a handle
 * that keeps the event loop alive or a timer that fires against a torn-down service.
 *
 * A store inverts it. Whatever a subsystem needs undone is registered AT THE MOMENT IT IS CREATED, next to the
 * code that knows about it, and shutdown is one call that cannot skip anything. The list stops being a thing
 * to remember because it stops being a list.
 *
 * DISPOSING IS NOT ALLOWED TO BE PARTIAL. A store keeps going after a member throws and reports the failures
 * together at the end, because the alternative — the first bad `dispose()` aborting the rest — is how one
 * misbehaving subsystem leaves a container's ports bound and its child processes orphaned. Errors are not
 * swallowed either; they arrive as one AggregateError once everything that could be released has been. */

export interface IDisposable {
    dispose(): void;
}

/* The escape hatch into the protocol for everything that already has its own word for stopping — a `close()`,
 * a `stop()`, a returned unsubscribe function, an interval handle. Wrapping at the registration site is what
 * lets a store hold subsystems that were never written to be disposables. */
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

    /* Registering into an ALREADY-disposed store disposes the newcomer immediately rather than holding it.
     * That case is real and it is not a caller error: an async boot step can land after a shutdown began, and
     * the honest reading of "add this to the things that get cleaned up" when cleanup has happened is to clean
     * it up. Holding it would leak; throwing would turn a benign race into a crash on the way out. */
    add<T extends IDisposable>(disposable: T): T {
        if (this.disposed) {
            disposable.dispose();
            return disposable;
        }
        this.members.add(disposable);
        return disposable;
    }

    // Same, for the things that stop by being called. Returns nothing to register back: what a caller would do
    // with the wrapper is delete it, and `deleteAndDispose` already covers that by identity.
    push(fn: () => void): void {
        this.add(toDisposable(fn));
    }

    // Release one member early — a terminal that closed, a watcher whose repo went away — so a long-lived
    // store does not grow for the lifetime of the process.
    deleteAndDispose(disposable: IDisposable): void {
        if (this.members.delete(disposable)) {
            disposable.dispose();
        }
    }

    get size(): number {
        return this.members.size;
    }

    /* Idempotent, and it empties before it disposes: a member whose `dispose()` reaches back into this store
     * (a supervisor tearing down the children it registered) then finds nothing to recurse into, instead of
     * iterating a set that is being mutated underneath it. */
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

/* The base for a class that owns disposables: `this.register(...)` at construction, and its own `dispose()` is
 * inherited. Subclasses that need teardown of their own override `dispose` and call `super.dispose()` — the
 * store is the LAST thing released that way, so a subclass can still reach its own members while stopping. */
export abstract class Disposable implements IDisposable {
    protected readonly store = new DisposableStore();

    protected register<T extends IDisposable>(disposable: T): T {
        return this.store.add(disposable);
    }

    dispose(): void {
        this.store.dispose();
    }
}

/* One slot holding at most one disposable, where assigning a new value releases the old one. This is the
 * shape of every "the current X" field in the daemon — the live watcher for the repo now open, the connection
 * for the account now selected — and writing it by hand is where the old value gets dropped without being
 * stopped, which is a leak that looks exactly like working code. */
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
