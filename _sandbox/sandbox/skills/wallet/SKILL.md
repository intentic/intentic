---
name: wallet
description: Pay x402-payable web endpoints in USDC from the sandbox wallet via the `wallet` CLI, under the owner's spending policy. Use when a useful API answers 402 Payment Required with an x402 challenge, or when a task needs a paid machine-payable service, check the price, then ask; the owner approves each payment on a card in chat unless it sits inside their standing auto-approve band.
---

# The sandbox wallet

This sandbox can hold a USDC balance and spend it on the open web: any endpoint that charges per request
over the x402 protocol (HTTP 402 + a machine-readable price). You reach it with the `wallet` command. The
wallet's signing key lives with the platform, never in this container: you can ask for a payment, and
nothing you can read or run can move money without the owner's policy allowing it.

## Commands

```sh
wallet status                                # address, network, balance, today's budget
wallet fetch <url> \
    --method POST --body '{"q":"…"}' \
    --max 0.50 \
    --why "one line on why this is worth paying for"
wallet history                               # what was paid, to whom, with tx hashes
```

`fetch` is an ordinary HTTP fetch that can pay: a free endpoint passes through untouched, and a 402 with an
x402 challenge starts the payment flow. The response body prints on stdout (composable); the receipt
("paid $0.10, tx 0x…") prints on stderr. Hold the command open: the owner's answer, ~2s of onchain
settlement, and the endpoint's real work all happen inside it. `--max` is your own ceiling for the one
call; use it whenever you have an expectation of what the price should be.

## How consent works: enforced, not promised

`fetch` does not spend on your say-so. The daemon makes the request itself, parses the endpoint's own
challenge, and checks the owner's policy: a hard per-payment ceiling, a daily cap, and host lists. Anything
outside the owner's auto-approve band raises an **approval card in the owner's chat**: price, recipient,
and today's meter on it, none of it quotable by you: and only their click releases the payment. One click
covers exactly one payment. Every payment is signed as a one-transfer authorization that expires within
minutes: a failed or refused payment spends nothing.

What that leaves you:

1. **Ask when it genuinely helps.** Your judgment is the URL, the request body, `--max`, and the one-line
   `--why` the card shows. Prefer free tools when they answer just as well.
2. **Never loop payments.** A declined or expired card answers with a sentence: act on it, don't re-ask.
   Offer the same payment again only when the owner asked you to continue.
3. **Quote prices from the wallet, not from memory.** `wallet status` and the refusal sentences carry the
   real numbers (price, caps, what's left today).
4. **Trust is yours to weigh.** x402 is pay-then-serve with no refunds: a paid endpoint that answers
   garbage keeps the money. Prefer endpoints the task named or well-known providers; say what you paid and
   what came back.

Two things happen automatically and are worth knowing rather than working around. A turn that has read
anything from outside (a fetched page, a stranger's message) loses the automatic-approval band for the
rest of that turn, so every payment asks in chat however small: content you read must not be able to spend
the owner's money quietly. And an unattended run (a schedule, a delegated turn) has nobody to answer a card,
so it can only make payments inside that band; above it, the payment refuses and the owner reads why later.

## Refusals you will meet

- `no_wallet`: no wallet is connected; ask with `capabilities request wallet --why "…"`.
- `over_payment_cap` / `over_daily_cap`: the owner's numbers said no; the sentence names them. Relay it,
  don't work around it.
- `no_matching_rail`: the endpoint charges on a network or token this wallet doesn't hold (it pays USDC on
  one configured network).
- `unsupported_protocol`: the endpoint charges over MPP (a different 402 dialect); this wallet speaks x402
  only.

Nothing was spent in any of these cases; each refusal says so explicitly.
