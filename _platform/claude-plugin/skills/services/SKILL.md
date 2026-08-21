---
name: services
description: Discover and run intentic's premium services (research, data, heavy compute) priced in the owner's membership credits. Use when a task would benefit from a capability no local tool provides, check the catalogue, then ask for a run; the owner approves it in their browser before anything is spent.
---

# Premium services

intentic lists metered services (research runs, data lookups, heavy compute) priced in the owner's
membership credits. You reach them through the `intentic` MCP server's three tools. Every run is forwarded by
the platform to the provider, spent from the owner's daily allowance, and **automatically refunded if the
service fails to answer**.

## The three tools

- **`services_list`**: every service, its price, and the credits left today. Free, spends nothing. Read it
  before asking for a run: the slug, the price and the provider's own worked example all come from here.
- **`services_run`**: ask for **one** metered run. Takes the slug, a request body shaped after that
  listing's example, and one line of `why`.
- **`services_wanted`**: the catalogue had nothing for this. One plain line, published only in aggregate.

## How consent works: enforced, not promised

`services_run` does not spend. It answers with a **link to an approval page on intentic**, showing the
service, the price, the exact body you composed, and today's balance: all read from the platform, none of it
quotable by you. The owner's click on that page is the only thing that releases the spend.

That is a property of the plumbing, not of your good behaviour. Approving in the terminal does nothing on its
own; the run re-reads what the browser wrote. So:

1. **Ask when it genuinely helps.** Your judgment is which service fits, the request body, and the one-line
   `why` the page shows. Prefer free tools when they answer just as well.
2. **Let the page do the talking.** Don't re-quote prices or balances in prose: the page states them from the
   platform, and your copy can only drift. Say that you've asked, then wait.
3. **Read refusals as answers.** "The owner skipped this run", "the approval expired", "needs a membership",
   "not enough credits today" are sentences to act on: continue without the service rather than retrying.
   A refunded provider failure may be retried once; nothing was charged, and it raises a fresh approval.
4. **Never loop runs.** One approval covers exactly one run. Asking again raises a new page, so a retry loop
   is a nag loop. Offer the same run again only when the owner asked you to continue.
5. **Quote outcomes.** After a served run, say what it cost and what's left: the numbers come back with the
   result.
6. **File a want when the catalogue comes up empty.** If nothing listed answers a need a paid service
   plausibly could, call `services_wanted` once and carry on with free tools. It spends nothing and asks
   nobody. Describe the *capability* ("flight price lookups with dates"): never the task's specifics, names,
   or anything personal.

## If the owner has no membership

`services_run` answers with a link to intentic's join page instead of an approval page. Say so plainly and
move on with free tools; don't stall the task waiting for a payment. If they join, ask again and the run
proceeds.

## A note on probation

A listing marked `[new]` passed intentic's mechanical admission checks but has not yet served enough runs to
graduate. Prefer an established service when both would answer, and say which you picked when it matters.
