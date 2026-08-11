---
name: services
description: Discover and run the platform's premium services (research, data, heavy compute) priced in the owner's membership credits, via the `services` CLI. Use when a task would benefit from a capability no local tool provides — check the catalog, quote the price in chat, and run only after the owner agrees.
---

# Premium services

The platform lists metered services — research runs, data lookups, heavy compute — priced in the owner's
membership credits. You reach them with the `services` command; every run is forwarded by the platform to
the provider, spent from the owner's daily allowance, and **automatically refunded if the service fails to
answer**.

## Commands

```sh
services list                          # every service, its price, and the credits left today
services run <slug> '{"query":"…"}'    # one metered run — JSON in, JSON out (or pipe the body via stdin)
```

`run` prints the provider's JSON on stdout (composable) and the remaining credits on stderr.

## Etiquette — this spends the owner's money

1. **Offer, don't spend.** When a service fits the task, say so in chat with the price and what's left:
   "I can run *acme-research* for 40 credits (960 left today) — want me to?" Then wait for a yes.
2. **One yes, one run.** A single agreement covers a single run. Repeats, retries after a real answer, and
   loops each need their own yes. (A refunded failure may be retried once without re-asking — nothing was
   charged.)
3. **Quote outcomes.** After a run, say what it cost and what's left — the numbers are on stderr.
4. **Refusals are answers.** "Needs a membership" or "not enough credits today, resets at midnight UTC" are
   sentences to relay to the owner, not errors to work around.
