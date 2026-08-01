/* Test-support seams for this package's suites. Not part of the build (tsconfig `exclude`) but type-checked
 * along with the tests (tsconfig.test.json).
 *
 * `unstubbed` replaces six hand-written copies of the same table — a `CloudflareApi`/`KomodoApi`/`ForgejoApi`
 * with every method pointed at a throwing NOT_USED, one copy per suite, so that a provider test only had to
 * name the two or three calls it actually asserts on. The copies were the problem: adding
 * `listStampedDnsRecords` to CloudflareApi left four of them describing an API that no longer exists, and
 * nothing said so, because *.test.ts was outside every type-check the repo ran. One definition, and what a
 * suite does stub is checked against the real interface.
 */

// Every method throws, named, until the test provides it. Use for a WIDE seam the code under test barely
// touches: enumerating no-ops for the rest says nothing and goes stale the moment the interface grows.
// Methods only — a seam with DATA members needs those spelled out, or a reader finds a function where it
// expected a value.
// NoInfer: T comes from the seam being stood in for (the annotated target), never from the subset a test
// happens to provide — otherwise the stand-in silently narrows to exactly what was written and checks nothing.
export const unstubbed = <T extends object>(seam: string, provided: NoInfer<Partial<T>>): T =>
    new Proxy(provided as T, {
        get: (target, key) =>
            key in target
                ? target[key as keyof T]
                : () => {
                      throw new Error(`${seam}.${String(key)} was called, and this test did not stub it`);
                  },
    });
