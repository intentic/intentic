// Shared fake-seam stand-in every suite builds its fakes on; source-consumed only (no dist, devDependencies), so
// nothing ships. One implementation instead of each package growing, and drifting from, its own.

// Keys the runtime calls unasked (`then` makes a value thenable, `toJSON` feeds JSON.stringify); left undefined.
const RESERVED = new Set(["then", "toJSON"]);

// An unprovided member throws when called, naming the full path reached (`services.komodoStore.seenAt`, not `seenAt`),
// and stays proxyable to any depth. Symbols answer `undefined` so inspection and equality probes see an ordinary
// function.
const namedThrow = (path: string): (() => never) =>
    new Proxy(
        () => {
            throw new Error(`${path} was called, and this test did not stub it`);
        },
        { get: (_target, key) => (typeof key === "symbol" || RESERVED.has(key) ? undefined : namedThrow(`${path}.${key}`)) },
    );

// Every unprovided member throws when called, named, so a wide seam needs no enumerated no-ops. A member read as data
// still needs providing, or it sees a function; `NoInfer<Partial<T>>` keeps T at the seam's real shape.
export const unstubbed = <T extends object>(seam: string, provided: NoInfer<Partial<T>>): T =>
    new Proxy(provided as T, {
        get: (target, key) =>
            key in target ? target[key as keyof T] : typeof key === "symbol" || RESERVED.has(key) ? undefined : namedThrow(`${seam}.${key}`),
    });
