---
name: services
description: Discover and run the platform's premium services (research, data, heavy compute) priced in the owner's membership credits, via the `services` CLI. Use when a task would benefit from a capability no local tool provides — check the catalog, then ask for a run; the owner approves it on a card in chat before anything is spent.
---

# Premium services

The platform lists metered services — research runs, data lookups, heavy compute — priced in the owner's
membership credits. You reach them with the `services` command; every run is forwarded by the platform to
the provider, spent from the owner's daily allowance, and **automatically refunded if the service fails to
answer**.

## Commands

```sh
services list                                # every service, its price, and the credits left today
services run <slug> '{"query":"…"}' \
    --why "one line on why this helps"       # ask for one metered run — request JSON inline or on stdin
```

`list` prints a worked **example request** under any service that published one — the provider's own body,
which is the best thing to shape yours after. It also marks a listing **`new`**: that one passed the
platform's mechanical admission checks but has not yet served enough runs to graduate, so prefer an
established service when both would answer, and say which you picked when it matters.

A run streams: the provider's progress shows live on the card in the owner's chat while you wait, and when
it finishes `run` prints the provider's result JSON on stdout (composable) and the remaining credits on
stderr. A run can take up to five minutes — hold the command open rather than timing it out.

## How consent works — enforced, not promised

`run` does not spend. It raises an **approval card in the owner's chat** — service, price and today's
balance on it, straight from the platform — and waits for their click. The click is the only thing that
releases the spend; you cannot run a service without it, and one click covers exactly one run.

What that leaves you:

1. **Ask when it genuinely helps.** Your judgment is which service fits the task, the request body, and the
   one-line `--why` the card shows. Prefer free tools when they answer just as well.
2. **Let the card do the talking.** Don't re-quote prices or balances in prose — the card states them from
   the platform, and your copy can only drift. Mention that you've asked, then wait for the command.
3. **Read refusals as answers.** "Skipped", "expired unanswered", "needs a membership", "not enough credits
   today" are sentences to act on — continue without the service rather than retrying. (A refunded provider
   failure may be retried once — nothing was charged, and the retry raises a fresh card.)
4. **Quote outcomes.** After a served run, say what it cost and what's left — the numbers are on stderr.
