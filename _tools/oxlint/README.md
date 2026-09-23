# oxlint

The lint standard this repo holds itself to, the vendored rules that extend it, and the hook that applies it
without spending an agent's attention on work a tool could do.

Linting is the only part of the house style that is executable. An AGENTS.md paragraph is a suggestion a model
weighs against everything else in its context; a failing rule is a fact it has to answer.

## Where things live

| | what it is | run by |
|---|---|---|
| `/.oxlintrc.json` | the whole standard — 251 rules, green on main | `pnpm lint`, editors, `lint-edit.mjs`, `pnpm verify:turn` |
| `/.oxlintrc.plugins.json` | the above plus anti-slop and cognitive complexity | `pnpm lint:plugins` — installed, not what `lint-edit.mjs` runs |
| `lint-edit.mjs` | the per-edit check | an `edit` check in `/.intentic/checks.json` |
| `_tools/oxlint/bun-test/` | test-hygiene rules for `bun:test` suites | `/.oxlintrc.json`, so every config above |
| `_tools/oxlint/anti-slop/` | vendored rule sources | `/.oxlintrc.plugins.json` |

## How it reaches the agent

`node _tools/oxlint/lint-edit.mjs {file}`, an `edit` check in `/.intentic/checks.json`, on every file a turn
writes, in whichever checkout holds that file:

1. **Autofixes first, and reports nothing it fixed.** Telling an agent about work the tool already did is a tax
   on the thing that is actually scarce. The fix loop runs to a fixpoint — one pass is not enough, because a fix
   can create the violation another rule repairs.
2. **Reports only what the edit introduced**, by diffing against the same file at `HEAD`.
3. **Never blocks on its own failure.** Missing binary, parse error, git failure: exit 0.

`pnpm lint` also runs in `pnpm verify:turn` over the turn's changed files, so a turn cannot end on a red linter.

## Complexity

Three different things get called "complexity" and they do not agree:

- **Nesting** — `max-depth: 4`, `max-nested-callbacks: 4`, both live in the root config. This is the part a
  reader actually feels, and it was 41 sites away, so it is enforced everywhere.
- **Cyclomatic** — not gated, because it pulls against nesting (below). Measured across this repo:
  737 functions over 10, 299 over 15, 142 over 20 (oxlint's default), 31 over 40. The worst is `runTurn` in
  `agent.routes.ts` at 188. The `modified` variant barely differs (29 vs 31 at a cap of 40), which is how you
  know this is real branching rather than flat `switch` dispatch being punished.
- **Cognitive** — `complexity/complexity` in `.oxlintrc.plugins.json`, via `oxlint-plugin-complexity`. The best
  metric of the three: it charges nothing for flat structure, compounds for depth, and names the lines that
  cost the most, which is what makes the diagnostic actionable rather than a number to argue with. Set to
  `{ cyclomatic: 20, cognitive: 20 }`, and both numbers were measured rather than inherited. Over the ~6.5k
  production functions of 10+ lines the rule examines: 657 exceed `[10, 15]`, 313 exceed `[15, 20]`, 276
  exceed `[20, 20]`. The plugin's cyclomatic charges +1 per `??`, `||` and `case`, so at 10 it was the
  binding constraint on 208 functions cognitive rated 5-9 — flat switches and nullish-default mappers, the code
  the metric exists to leave alone; at 20 it binds alone on 16, all 21-44 flat dispatchers. Cognitive is 20
  rather than SonarSource's 15 because this plugin also charges +1 per nested-function level and +1 for
  recursion, which Sonar does not, so a loop over callbacks scores 3-6 higher here than the number 15 was
  calibrated for; every sampled function in the 16-20 band was a self-contained algorithm (Kahn's sort, a fuzzy
  matcher, a streaming line reader) and the first three-deep nesting appears at 21.

**The first two pull against each other, and it matters.** Flattening `if (a) { if (b) {` into `if (a && b) {`
removes a level of depth and ADDS a branch point, so satisfying `max-depth` by merging conditions makes
cyclomatic complexity worse — measured, while doing exactly that: `runTurn` went 188 → 194. Extraction into a
named helper is the move that improves both, and it is what most of the 41 nesting fixes became. If you are
choosing between the two techniques, that is the tiebreak.

## Why rules are enumerated, not categorised

Oxlint's categories are buckets of available rules, not curated presets — there is no `recommended` preset yet
([oxc#20758](https://github.com/oxc-project/oxc/issues/20758)). Measured here: `pedantic` produces 12,061
errors, `restriction` 52,273, `style` 132,893. Worse than the volume, the wide categories are internally
contradictory — `restriction` carries `no-async-await`, `no-optional-chaining` and `no-rest-spread-properties`,
which fight `require-await`, `prefer-optional-chain` and most of this codebase.

Enumerating also pins the rule set across upgrades, so an oxlint bump cannot silently change what an agent is
being told to do in the middle of a task.

## Rules that are off, and why

The root config carries the reasoning inline, next to each rule. They fall into three groups.

**Wrong about this codebase.** `no-await-in-loop` (953 hits, sequential writes that are the intent);
`unicorn/consistent-function-scoping` (185, deliberate factory closures); `unicorn/no-hex-escape` (control
characters this repo handles on purpose).

**Punishing the code that does the right thing.** Each of these was sampled at its own call sites before being
switched off — the test is not "is the rule reasonable in the abstract" but "is the code it flags here worse
than the code it would produce":

- `no-script-url` fired on the `href.startsWith("javascript:")` guard and the two tests asserting that
  `javascript:alert(1)` is rejected. It cannot be satisfied without deleting the defence.
- `no-control-regex` fired inside `_tools/registry-scan`, whose job is to find control characters.
- `oxc/no-map-spread` never fired on the quadratic `[...acc, x]` it targets; it fired on
  `automations.map((a) => ({ ...a, enabled: false }))`, and its help suggests `Object.assign` or "direct
  property assignment" — i.e. mutate the input.
- `unicorn/no-array-sort` fired on `[...byKey.values()].sort(...)`, where the array was spread into existence
  one expression earlier. `toSorted()` there allocates a second array to throw the first away.
- `promise/no-multiple-resolved` counted the two arms of `port === 0 ? reject(…) : resolve(…)` as two
  resolutions of one promise.
- `promise/no-callback-in-promise` and `no-promise-in-callback` fired on
  `handleEntry(...).then(() => next(), fail)` inside a tar-stream handler — the only way to drive a callback
  API from a promise.
- `unicorn/prefer-structured-clone` fired on `JSON.parse(JSON.stringify(x))` used deliberately for its JSON
  semantics; one call site is literally named `wire()`.
- `no-use-before-define` is 360 hits, every one sampled being a helper called from inside another function's
  body or a default parameter evaluated at call time. The bug it nominally guards is already a compile error
  here (TS2448/TS2454).

**Cosmetic, and measured to cost more than they return.** `unicorn/catch-error-name` (170 renames, and its
autofix walked `no-shadow` from 17 hits to 104 by colliding with outer `error` bindings),
`unicorn/prefer-string-replace-all` (230 sites), `promise/param-names`, `no-useless-concat`.

One rule is off for a different reason entirely: **`unicorn/prefer-dom-node-append`'s autofix is not
value-safe.** `appendChild()` returns the node it appended; `append()` returns undefined. Oxlint ships the
rewrite as a plain `--fix`, and it silently broke two call sites that used the return value — caught by tsc,
not by the linter. `lint-edit.mjs` applies `--fix` without showing the agent what it changed, so a fix that can
alter a value is the one kind this setup must not carry.

## Test assertions, and the half of it a linter cannot see

The only part of test QUALITY that is executable, and it is worth being exact about how small that part is.

**Brittleness is not in the AST.** A 22-key `toEqual` is the correct assertion when the shape IS the contract
and an over-specification when it is not, and the two are byte-identical. Every candidate rule was measured
across the repo and sampled at its own call sites before being rejected — the same test everything in the
section above had to pass:

| rule | hits | why not |
|---|---|---|
| `jest/prefer-expect-assertions` | 10,710 | ceremony |
| `vitest/require-test-timeout` | 10,664 | already solved better, by kind-based budgets in `_tools/testing` |
| `jest/prefer-strict-equal` | 5,701 | pushes the WRONG way — `toStrictEqual` pins undefined keys and class identity |
| `vitest/no-conditional-in-test` | 1,199 | outlaws table-driven tests, like `no-conditional-expect` above |
| `jest/prefer-called-with` | 48 | couples an assertion to exact arguments |

Sampled sites for the "brittle" shapes were correct tests in every case: `acp-bridge/src/translate.test.ts`
asserts a 13-key object because that shape is the function's whole contract, and
`_tools/base/src/async.test.ts` asserts `toHaveBeenCalledTimes(2)` because that IS what `SingleFlight`
promises.

**What is decidable is the opposite: an assertion that cannot fail.** `toBeDefined` says only "not undefined";
`toBeTruthy` passes for any non-empty string and every object ever constructed. That is a shape.
`bun-test/no-restricted-matchers` carries the ban list, and the reason on each entry is the rule rather than
decoration — it is printed with the diagnostic and is the only part an agent can act on.

It is in the ROOT config, green, with no backlog. It started at 328 sites (`toBeDefined` 254,
`toHaveBeenCalled` 46, `toBeTruthy` 18, `toBeFalsy` 5, `resolves.not.toThrow` 1) and every one was given the
assertion it should have had. How, in case the next sweep is tempted to do it by hand:

- Most `toBeDefined` sites were a **narrowing guard** with the real assertion on the next line, using `!`.
  Those collapse into one `toMatchObject` — shorter, and it cannot pass on undefined either.
- The rest were rewritten **from the type**: strip `undefined` off what the checker already knows and assert
  the arm that is left (`expect.any(String)`, `Array`, `Function`, …). "Not undefined" and "is a string" fail
  on the same value; the second also fails on the wrong shape. A ~90-line codemod over a `ts.Program` did 144
  of them and declined the ones where the remaining type was not one thing.
- `expect(bag[key]).toBeDefined()` became `expect(Object.keys(bag)).toContain(key)`, which prints the keys
  that ARE there rather than the word "undefined".
- `toHaveBeenCalled` became `toHaveBeenCalledTimes(n)` or `…With(…)`. Watch the negation: `.not.toHaveBeenCalled()`
  is a *strong* assertion and must not be swept up with it — `.not.toHaveBeenCalledTimes(1)` passes when the spy
  was called twice.

**Three of them found real bugs**, which is the argument for the rule in one line: a `features` set that
arrives as an array and would have satisfied any presence check as `{}`; a rank test that computed a baseline,
never compared against it, and so never made the claim in its own name; and a `window.open` spy never cleared
between tests, so half a suite's counts depended on file order.

The rule is this repo's own, for the reason the `bun-test` section below gives: oxlint's `jest/` and `vitest/`
namespaces cannot see a suite that imports from `bun:test`, and the hit counts in the table above were measured
while the suites still imported from `vitest`.

**Neither half says whether a test detects a fault.** That question is answered by running the code broken and
watching: the `test-strength` chore mutates the source and counts what the suite notices. The assertion ratchet
(`_tools/scripts/verify/assertion-ratchet.mjs`, in `pnpm verify:turn` and the push) measures strength, not
detection: every changed test file's assertions against the same file at the main-line base. Measured on `sandbox-contract`'s chore module — 109 tests, every line covered — 16 of 58 mutants
survived.

## Conflicts, and how they are resolved

Two diagnostics on one line with two different remedies is how a fix loop starts oscillating. Where rules
overlap, one is chosen and the other is explicitly off:

- **Type assertions** — `typescript/no-unsafe-type-assertion` is off; anti-slop owns assertions, because it
  offers a way through (justify it) rather than a demand that cannot always be met.
- **`typeof` narrowing** — `unicorn/no-typeof-undefined` owns and autofixes `typeof x === "undefined"`;
  anti-slop's `no-runtime-typeof` runs with `allowInTypeGuards` so it does not re-flag the same line.
- **Always-on beats type-aware where they duplicate** — `no-throw-literal` over
  `typescript/only-throw-error`, the eslint `prefer-promise-reject-errors` and `no-implied-eval` over their
  typescript twins, `unicorn/prefer-string-starts-ends-with` over the typescript one.
- **`any` and `unknown` together** — `typescript/no-explicit-any` and anti-slop's `no-unknown-*` are both on.
  Closing one escape hatch alone just moves the traffic to the other.

Two rules are off for noise rather than conflict: `strict-boolean-expressions` rejects every truthiness check,
and `prefer-readonly-parameter-types` wants deep-readonly signatures across the codebase.

## Type-aware linting

The ~50 rules that need a checker are declared in the root config and run only under `pnpm lint:types`
(oxlint `--type-aware`, backed by `oxlint-tsgolint`). Plain `pnpm lint` ignores them at no cost.

This is the half that catches what a language model actually gets wrong, because none of it is visible without
types: a dropped `await` (`no-floating-promises`), an `any` crossing a boundary (`no-unsafe-*`), a cast the
checker cannot justify, a union that grew a member while a `switch` did not (`switch-exhaustiveness-check`),
and — the one that most directly answers a model writing against the API it remembers from training —
`no-deprecated`.

**Not yet runnable.** `pnpm lint:types` needs `oxlint-tsgolint`, which is not in the manifest: adding a
dependency invalidates the lockfile, and an install cannot run in the same turn that edits the manifest, so
adding it would land the repo on a red `pnpm verify`. To turn it on:

```
pnpm-workspace.yaml catalog:       oxlint-tsgolint: 7.0.2001
root package.json devDependencies: "oxlint-tsgolint": "catalog:"
pnpm install && pnpm lint:types
```

Expect a real backlog on first run; that measurement decides whether type-aware joins the stop gate or lands
as the next ratchet entry.

## bun-test

`bun-test/` is six rules over the suites, configured in `/.oxlintrc.json` and gated by `pnpm lint`. They exist
because **oxlint's own `jest/` and `vitest/` rules recognise a test function only when it is imported from
`vitest` or `@jest/globals`.** Every one of the ~1,575 files here imports from `bun:test`, so the whole family
was silent: measured, a file with `it.only`, `it.skip` and two identical titles reported three errors with a
`vitest` import and zero with a `bun:test` one. `settings.jest` and `settings.vitest` carry no import-source
option, so there was nothing to configure.

| rule | replaces |
|---|---|
| `bun-test/no-focused-tests` | `vitest/no-focused-tests` |
| `bun-test/no-disabled-tests` | `vitest/no-disabled-tests` |
| `bun-test/no-identical-title` | `vitest/no-identical-title` |
| `bun-test/no-restricted-matchers` | `jest/no-restricted-matchers` |
| `bun-test/expect-expect` | `vitest/expect-expect` |
| `bun-test/no-standalone-expect` | `vitest/no-standalone-expect` |

**Every rule resolves the name to its import** before it fires, the way anti-slop's `no-module-mocking` does, so
a local binding called `test` or `it` in production code is never a test, and `_tools/onboarding/specs` — whose
`test.skip(condition, reason)` comes from `@playwright/test` — is left alone.

Two places where the semantics are deliberate rather than inherited:

- **The conditional forms are not disabled tests.** `describe.skipIf`, `test.skipIf`, `it.runIf` and `todoIf`
  state the condition they wait on, which is the opposite of a test nobody checks. Only bare `.skip` and
  `.todo` are rejected.
- **A restriction names a whole chain.** `toBeTruthy` matches `expect(x).toBeTruthy()` and leaves
  `expect(x).not.toBeTruthy()` alone, which is what `jest/no-restricted-matchers` did and what the negation
  note above depends on: there are 368 `.not.toHaveBeenCalled()` call sites here and every one of them is a
  strong assertion.

`no-standalone-expect` also allows an `expect` inside a `beforeAll`/`afterEach` body, which oxlint's
`vitest/no-standalone-expect` reports: a hook runs with the test, not with collection, and about 190 hook
bodies here assert in one. An `expect` inside an ordinary helper function is allowed for the same reason —
`route-turns.testing.ts` asserts the shape of an attach stream on behalf of its callers. What is left is the
shape the rule is for: an assertion in a `describe` body or at module level, which runs once while bun is
still reading the file.

## anti-slop

`anti-slop/` is vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `6d53855`, MIT.
It is configured in `/.oxlintrc.plugins.json`, installed, and **not what `lint-edit.mjs` runs**.

These are the only rules here written against an author rather than a bug. They reject code that type-checks
and runs but has thrown away the evidence that it is correct — `as unknown as T`, `unknown` in a signature,
widen-then-assert, a dictionary typed as `object`. That is the shape a model reaches for when it does not know
something and needs the compiler to stop asking.

The one that pays for the set is `require-safety-comment-for-type-assertion`: an assertion is allowed, but it
has to state the invariant that makes it safe. That converts an unanswerable "prove this cast" into something
an agent can actually do, and leaves a reviewable trail where there was none.

Vendored rather than depended on, deliberately — the rules encode taste, and taste should be readable and
editable in the tree it governs. The directory is in `.prettierignore` and the root config's `ignorePatterns`
so it stays byte-comparable with upstream.

**`no-module-mocking` is off.** Upstream rejects `vi.mock` outright in favour of real dependency seams. That is
a coherent position and not this repo's — 461 call sites disagree, and a rule that fires on all of them is not
a standard, it is a rewrite of the testing architecture filed as a lint rule.

## Disable comments

`unicorn/no-abusive-eslint-disable` is on, so a blanket `oxlint-disable` is itself an error. A targeted
`// oxlint-disable-next-line <rule> -- <reason>` is fine and is how the handful of genuine one-off exceptions
are recorded: a generator that only ever throws, an untyped third-party module, a binding a closure captures
before it is assigned. Each one names the rule and says why.
