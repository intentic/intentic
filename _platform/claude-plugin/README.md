# intentic — paid services in Claude Code

Lets a Claude Code session discover and run intentic's metered services (research, data, heavy compute), with
the spending decision kept firmly with you.

```sh
/plugin marketplace add intentic/intentic
/plugin install intentic@intentic
/mcp                      # sign in once, in your browser
```

No sandbox, no Docker, no install beyond the plugin. An intentic account is enough; a membership is what pays
for runs, and you can buy one from the terminal without ever opening the app.

## What your agent gets

Three tools, and nothing else on the platform:

| Tool | What it does | Spends |
| --- | --- | --- |
| `services_list` | the catalogue, prices, and credits left today | nothing |
| `services_run` | asks for **one** metered run | only after you click |
| `services_wanted` | files "the catalogue had nothing for this" | nothing |

It gets no access to your code, your files, or anything else in your intentic account.

## How spending works

`services_run` cannot spend. It hands your agent a link to an approval page on intentic showing the service,
the price, **the exact request body the agent composed**, and today's remaining credits. Your click on that
page is the only thing that releases the run.

This is enforced rather than promised, and the distinction is worth stating plainly, because Claude Code can
auto-answer the dialog that surfaces the link:

- the approval is a row on intentic that only your browser session can write;
- the run re-reads that row before charging anything;
- so an auto-answered dialog releases **nothing** — it just leaves the approval unclicked;
- one approval covers exactly one run, and a repeat asks again;
- a service that fails to answer is refunded before any receipt exists.

Headless runs (`claude -p`, SDK sessions) cannot show the dialog. Those refuse rather than auto-approving.

## Membership

Runs are priced in credits from a membership. If you don't have one, the first `services_run` hands you a
join page instead of an approval page — buy there and ask your agent to try again. The membership belongs to
your account, not to any machine, so it works the same whether or not you ever run an intentic sandbox.

Cancel any time from Stripe's own portal. Card details never touch intentic.

## Self-hosting

The server URL lives in [`.mcp.json`](.mcp.json). Point it at your own platform's `/mcp` if you run one; the
OAuth discovery, the catalogue and the approval pages all come from whichever platform that is.

## Related

- [`iq`](../../_search/iq/plugin) — the other intentic plugin, for workspace search.
- The catalogue is public at [intentic.dev/earn/catalog](https://intentic.dev/earn/catalog), including what
  agents asked for and nobody serves yet.
