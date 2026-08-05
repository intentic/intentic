/* The stand-in every suite in the monorepo builds its fakes on. Source-consumed (no dist): nothing here ships,
 * and a package depends on it in devDependencies only.
 *
 * It lives in one place because the copies were the bug. `_deploy/providers` and `_sandbox/sandbox` each grew their
 * own `unstubbed`, and the two drifted the moment they were written: the providers copy answers an unread key
 * with a THROWING FUNCTION one level deep and never guards `then`, which is exactly the pair of holes the
 * sandbox copy's comments record paying for — a nested `services.komodoStore.seenAt()` reporting "seenAt is not
 * a function" instead of naming the short fake, and eight turn-resume tests dying inside the await machinery
 * because a callable `then` makes any value a thenable. A seam this small is not worth owning twice.
 */

/* The keys a stand-in must never answer: the ones the LANGUAGE reads off an arbitrary value and calls without
 * anybody asking. A value carrying a callable `then` IS a promise as far as the runtime is concerned, so
 * `await fake` — or merely returning one from an async function — hands the resolution machinery a stand-in it
 * then CALLS; `toJSON` is the same trick one layer out, invoked by `JSON.stringify` on every fake that reaches
 * a log line or a serialized assertion. Both report as the protocol's own failure and name nothing about the
 * seam. Absent instead — a seam that really has one of these gets it from the test like any other member. */
const RESERVED = new Set(["then", "toJSON"]);

/* What an unprovided member answers: a value that is both callable and readable to any depth, and that names
 * the WHOLE path it was reached by when something finally calls it. Depth is the point — a service tree stood
 * in for one level deep answers `services.komodoStore.seenAt()` with "seenAt is not a function", which says
 * nothing about which fake is short. Symbols answer undefined so that `util.inspect`, `Symbol.toStringTag` and
 * vitest's own equality probes see an ordinary function. */
const namedThrow = (path: string): (() => never) =>
    new Proxy(
        () => {
            throw new Error(`${path} was called, and this test did not stub it`);
        },
        { get: (_target, key) => (typeof key === "symbol" || RESERVED.has(key) ? undefined : namedThrow(`${path}.${key}`)) },
    );

/* Every member throws, named, until the test provides it. Use for a WIDE seam the code under test barely
 * touches (a 37-method git, a 22-field settings store, a 130-member Services): enumerating no-ops for the
 * other 35 is noise that says nothing, and it goes stale the moment the interface grows. What a test does
 * provide is checked against T as usual; what it doesn't fails loudly with its own name instead of as a bare
 * 500 from whichever route reached it first.
 *
 * This is what keeps a fake OFF the blast radius of its seam growing: a new required member of T needs no edit
 * in any suite. Methods and nested seams only — a member the code reads as DATA (`if (config.publicUrl)`)
 * still has to be spelled out, or the branch sees a function where it expected a value.
 *
 * NoInfer: T comes from the seam being stood in for (the annotated target), never from the subset a test
 * happens to provide — otherwise the stand-in silently narrows to exactly what was written and checks nothing.
 */
export const unstubbed = <T extends object>(seam: string, provided: NoInfer<Partial<T>>): T =>
    new Proxy(provided as T, {
        get: (target, key) =>
            key in target ? target[key as keyof T] : typeof key === "symbol" || RESERVED.has(key) ? undefined : namedThrow(`${seam}.${key}`),
    });
