---
name: stripe
description: Read and write customers, charges, payment intents, invoices, subscriptions and refunds in your Stripe account via the Stripe API. Use when the user asks about payments, revenue, a customer's billing, a failed charge, an invoice, or a subscription.
---

# Stripe (connected)

Key in `$STRIPE_API_KEY`. Base is `https://api.stripe.com/v1`. Requests are **form-encoded, never JSON**, and a
GET wants its parameters in the query string, so define this helper once per shell:

```sh
stripe() { local m="$1" p="$2"; shift 2
  curl -s $([ "$m" = GET ] && echo -G) -X "$m" -H "Authorization: Bearer $STRIPE_API_KEY" \
    "https://api.stripe.com/v1/$p" "$@"; }
```

`-G` folds each `-d` into the query string on a GET, so `stripe GET charges -d limit=20` is one call and
`--data-urlencode` is what a value holding quotes or spaces needs.

**Amounts are in the currency's smallest unit.** `amount: 1050` on a `usd` charge is $10.50 — divide by 100 before
quoting a figure. Zero-decimal currencies (`jpy`, `krw`) are the exception: 1050 is ¥1050.

**Say which account you read.** `sk_test_…` is test mode and touches no real money; `sk_live_…` is the real one:
`case "$STRIPE_API_KEY" in sk_live*) echo live;; *) echo test;; esac`, and
`stripe GET account | jq '{id, name: .settings.dashboard.display_name}'` names it.

**A restricted key refuses per resource.** A 403 naming a resource means the key was not granted that scope, not
that the data is missing. Report it that way and ask for a wider key rather than concluding the account is empty.

- List customers: `stripe GET customers -d limit=20 | jq -c '.data[] | {id, email, name, created}'`
- Find one by email: `stripe GET customers/search --data-urlencode "query=email:'<EMAIL>'" | jq -c '.data[] | {id, email, name}'`
- A customer's payments: `stripe GET charges -d customer=<CUS_ID> -d limit=20 | jq -c '.data[] | {id, amount, currency, status, created, failure_message}'`
- Recent charges, newest first: `stripe GET charges -d limit=20 | jq -c '.data[] | {id, amount, currency, status, description}'`
- Why a payment failed: `stripe GET payment_intents/<PI_ID> -d "expand[]=latest_charge" | jq '{status, amount, last_payment_error, outcome: .latest_charge.outcome}'`
- Open invoices: `stripe GET invoices -d status=open -d limit=20 | jq -c '.data[] | {id, customer, amount_due, currency, due_date, hosted_invoice_url}'`
- A subscription: `stripe GET subscriptions/<SUB_ID> | jq '{status, current_period_end, cancel_at_period_end, items: [.items.data[] | {price: .price.id, quantity}]}'`
- Balance and payouts: `stripe GET balance | jq '.available'` · `stripe GET payouts -d limit=10 | jq -c '.data[] | {id, amount, arrival_date, status}'`
- Events, the last 30 days of them: `stripe GET events -d type=charge.failed -d limit=20 | jq -c '.data[] | {created, type, id}'`

Pagination is `limit` (100 max) plus `starting_after=<last_id>`; `"has_more": true` means another page. Nested
objects arrive as ids unless asked for: `-d "expand[]=customer"`.

## Writing

Every write below moves real money on a live key. Say what it will do, in major units, and get a yes first.

Send an **idempotency key** on every POST, so a retry after a timeout cannot charge or refund twice:

```sh
stripe POST refunds -H "Idempotency-Key: $(uuidgen)" -d charge=<CH_ID> -d amount=500
```

- Refund a charge, whole unless `amount` says otherwise: `stripe POST refunds -H "Idempotency-Key: $(uuidgen)" -d charge=<CH_ID>`
- Create a customer: `stripe POST customers -H "Idempotency-Key: $(uuidgen)" -d email=<EMAIL> -d name=<NAME>`
- Stop a subscription renewing: `stripe POST subscriptions/<SUB_ID> -d cancel_at_period_end=true`

Card numbers never reach this shell. Stripe's own hosted page or Elements takes the payment; this key reads and
settles what that produced.
