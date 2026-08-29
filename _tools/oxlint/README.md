# oxlint

The lint standard this repo holds itself to, the vendored rules that extend it, and the hook that applies it
without spending an agent's attention on work a tool could do.

Linting is the only part of the house style that is executable. An AGENTS.md paragraph is a suggestion a model
weighs against everything else in its context; a failing rule is a fact it has to answer.

## Where things live

| | what it is | run by |
|---|---|---|
| `/.oxlintrc.json` | the whole standard — 256 rules, green on main | `pnpm lint`, editors, the stop gate, the edit hook |
| `/.oxlintrc.anti-slop.json` | the above plus the 15 anti-slop rules | `pnpm lint:slop` — **not live**, needs a dependency |
| `_tools/oxlint/anti-slop/` | vendored rule sources | loaded by the config above |

There was briefly a second, stricter config holding rules main did not satisfy, applied only to files an agent
touched. That backlog reached zero, so it is gone: main meets its own standard and there is one config again.
If a future rule lands that main violates, it goes back in the same shape — off in the root config, with its
count, and a note naming who enforces it in the meantime.

## How it reaches the agent

`.claude/hooks/oxlint-edit.mjs`, on every `Edit`/`Write`:

1. **Autofixes first, and reports nothing it fixed.** Telling an agent about work the tool already did is a tax
   on the thing that is actually scarce. The fix loop runs to a fixpoint — one pass is not enough, because a fix
   can create the violation another rule repairs.
2. **Reports only what the edit introduced**, by diffing against the same file at `HEAD`.
3. **Never blocks on its own failure.** Missing binary, parse error, git failure: exit 0.

`pnpm lint` also runs in the stop gate, so a turn cannot end on a red linter.

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
`vitest/require-mock-type-parameters` (977, ceremony); `unicorn/consistent-function-scoping` (185, deliberate
factory closures); `unicorn/no-hex-escape` (control characters this repo handles on purpose).

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
- `vitest/no-conditional-expect` breaks table-driven tests, which is how most suites here are written.
- `vitest/valid-title` demands a literal, outlawing `test(name, …)` — every parameterised suite.
- `vitest/no-commented-out-tests` was 100% false positives, matching the word "it" followed by a parenthesis in
  English prose, in files that are not tests.
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
not by the linter. The edit hook applies `--fix` without showing the agent what it changed, so a fix that can
alter a value is the one kind this setup must not carry.

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

## anti-slop

`anti-slop/` is vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `6d53855`, MIT.
It is configured in `/.oxlintrc.anti-slop.json` but **not yet running** — it needs `@oxlint/plugins`, and that
file carries the four steps to turn it on.

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
