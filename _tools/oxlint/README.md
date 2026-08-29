# oxlint

The lint standard this repo holds new code to, and the machinery that applies it without spending an agent's
attention on work a tool could do.

Linting is the only part of the house style that is executable. An AGENTS.md paragraph is a suggestion a model
weighs against everything else in its context; a failing rule is a fact it has to answer. So the rules are
where the standard actually lives, and this directory is the strict half of it.

## The configs

| | `/.oxlintrc.json` | `agent.oxlintrc.json` | `anti-slop.oxlintrc.json` |
|---|---|---|---|
| what it is | what main satisfies today | what new code is held to | the above, plus anti-slop |
| run by | `pnpm lint`, editors, the stop gate | the edit hook, `pnpm lint:agent` | `pnpm lint:slop` |
| scope | every file | files an agent just wrote | same, once wired |
| rules | 234 | 270 | 270 + 15 |
| live | yes | yes | **not yet** — needs a dependency |

They are not three opinions. Each `extends` the one before it. The agent config adds back exactly what the root
config had to switch off to stay green; when main's count for a backlog rule reaches zero, delete that line
from the root config and the two converge a little further.

The split exists because of what a red gate does to an agent. A standard the repo cannot meet produces failures
on code the agent did not write, and the cheapest way out of those is a disable comment. One config that is
honest about the present, one that is strict about the future, keeps both properties.

## The backlog

`/.oxlintrc.json` carries a block listing 36 rules main violates, each with its count — 272 violations in
total, measured at oxlint 1.76.0. That block is a work list, not an exemption: every rule in it is enforced on
any file an agent touches. Fixing a rule's sites and deleting its line is a good standalone change.

Separately, and not part of the backlog, a handful of rules are off *on the merits* — they are wrong here
rather than merely unmet. Each carries its reasoning in place: `vitest/valid-expect` miscounts the arguments of
the call being asserted on (109 false positives), `no-await-in-loop` fires on sequential writes that are the
intent, `unicorn/no-hex-escape` rewrites control characters this repo handles deliberately, and three cosmetic
rules were measured to cost a ~400-file diff — `unicorn/catch-error-name`'s renames alone walked `no-shadow`
from 17 hits to 104 by colliding with outer `error` bindings.

## How it reaches the agent

`.claude/hooks/oxlint-edit.mjs`, on every `Edit`/`Write`. It does three things worth knowing about:

1. **Autofixes first, and reports nothing it fixed.** Most of what these rules catch has a safe fix. Telling an
   agent about work the tool already did is a tax on the thing that is actually scarce.
2. **Reports only what the edit introduced.** Each diagnostic is checked against the same file at `HEAD` and
   dropped if it was already there, so opening a legacy file does not hand the agent somebody else's backlog.
3. **Never blocks on its own failure.** Missing binary, parse error, git failure: exit 0.

What survives all three goes back as a blocking message with file, line and the rule's reasoning. In practice
that is a short list of genuine decisions.

Type-aware rules are not run here — they need whole-program types and cost seconds per file. They belong to a
once-per-turn gate, not a per-edit one.

## Type-aware linting

The ~50 rules that need a checker are declared in the root config and run only under `pnpm lint:types`
(oxlint `--type-aware`, backed by `oxlint-tsgolint`). Plain `pnpm lint` ignores them at no cost.

This is the half that catches what a language model actually gets wrong, because none of it is visible without
types: a dropped `await` (`no-floating-promises`), an `any` crossing a boundary (`no-unsafe-*`), a cast the
checker cannot justify, a union that grew a member while a `switch` did not
(`switch-exhaustiveness-check`), and — the one that most directly answers a model writing against the API it
remembers from training — `no-deprecated`.

**Not yet runnable.** `pnpm lint:types` needs `oxlint-tsgolint`, which is not in the manifest: adding a
dependency invalidates the lockfile, and an install cannot run in the same turn that edits the manifest, so
adding it would land the repo on a red `pnpm verify`. To turn it on:

```
pnpm-workspace.yaml catalog:      oxlint-tsgolint: 7.0.2001
root package.json devDependencies: "oxlint-tsgolint": "catalog:"
pnpm install && pnpm lint:types
```

The rules themselves are already declared in the root config and cost nothing while inert. Expect a real
backlog on first run; that first measurement is what decides whether type-aware joins the stop gate or becomes
the next ratchet entry.

## anti-slop

`anti-slop/` is vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `6d53855`, MIT.
It is configured in `anti-slop.oxlintrc.json` but **not yet running** — it needs `@oxlint/plugins` in the tree,
and that config file carries the four steps to turn it on. Measure it with `pnpm lint:slop` before pointing the
hook at it; the size of the backlog decides whether it lands as errors or as the next ratchet entry.

These are the only rules here written against an author rather than a bug. They reject code that type-checks
and runs but has thrown away the evidence that it is correct — `as unknown as T`, `unknown` in a signature,
widen-then-assert, a dictionary typed as `object`. That is the shape a model reaches for when it does not know
something and needs the compiler to stop asking.

The one that pays for the set is `require-safety-comment-for-type-assertion`: an assertion is allowed, but it
has to state the invariant that makes it safe. That converts an unanswerable "prove this cast" into something
an agent can actually do, and leaves a reviewable trail where there was none.

Vendored rather than depended on, deliberately — the rules encode taste, and taste should be readable and
editable in the tree it governs. To re-sync, diff against upstream and port what you want; the directory is in
`.prettierignore` and the root config's `ignorePatterns` so it stays byte-comparable.

**`no-module-mocking` is off.** Upstream rejects `vi.mock` outright in favour of real dependency seams. That is
a coherent position and not this repo's — 461 call sites disagree, and a rule that fires on all of them is not
a standard, it is a rewrite of the testing architecture filed as a lint rule.

## Why rules are enumerated, not categorised

Oxlint's categories are buckets of available rules, not curated presets — there is no `recommended` preset yet
([oxc#20758](https://github.com/oxc-project/oxc/issues/20758)). Measured against this repo: `pedantic` produces
12,061 errors, `restriction` 52,273, `style` 132,893. Worse than the volume, the wide categories are
internally contradictory — `restriction` carries `no-async-await`, `no-optional-chaining` and
`no-rest-spread-properties`, which fight `require-await`, `prefer-optional-chain` and most of this codebase.

Enumerating also pins the rule set across upgrades, so an oxlint bump cannot silently change what an agent is
being told to do in the middle of a task.

## Conflicts, and how they are resolved

Two diagnostics on one line with two different remedies is how a fix loop starts oscillating. Where rules
overlap, one is chosen and the other is explicitly off:

- **Type assertions** — `typescript/no-unsafe-type-assertion` is off; anti-slop owns assertions, because it
  offers a way through (justify it) rather than a demand that cannot always be met.
- **`typeof` narrowing** — `unicorn/no-typeof-undefined` owns and autofixes `typeof x === "undefined"`;
  anti-slop's `no-runtime-typeof` runs with `allowInTypeGuards` so it does not re-flag the same line.
- **Always-on beats type-aware where they duplicate** — `no-throw-literal` over
  `typescript/only-throw-error`, the eslint `prefer-promise-reject-errors` and `no-implied-eval` over their
  typescript twins, `unicorn/prefer-string-starts-ends-with` over the typescript one. The cheap rule runs in
  the edit hook; its type-aware twin would only ever repeat it.
- **`any` and `unknown` together** — `typescript/no-explicit-any` and anti-slop's `no-unknown-*` are both on.
  Closing one escape hatch alone just moves the traffic to the other.

Two rules are off for noise rather than conflict: `strict-boolean-expressions` rejects every truthiness check,
and `prefer-readonly-parameter-types` wants deep-readonly signatures across the codebase.

## The one rule the rest depend on

`unicorn/no-abusive-eslint-disable`. Without it the cheapest way for an agent to make the linter quiet is a
blanket `oxlint-disable`, and every other rule here becomes advisory.
