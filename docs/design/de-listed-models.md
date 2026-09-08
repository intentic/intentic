# A model the provider stops listing: what happens to the chats pinned to it

Written 2026-09-08 from the source as it stands. The question asked: a session pinned to Claude Opus 4.6
(Thinking) on the Google channel kept moving itself to Gemini 3.1 Pro (Low) — in the composer, and then in the
turn auto-continue sent — whenever Google was out of capacity for Opus. Nothing in the product claims to move
a turn between models: `moveAfterLimit` is same-provider-and-account by construction and `autoTier` skips a
rung on another provider rather than trying it. The answer, stated once here and argued below: **a model
missing from one catalog read is a state that ends, not a decision; the catalog holds it for a grace window,
the composer only ever borrows a pick and owes it back, and a pin the provider genuinely no longer serves ends
the turn instead of quietly spending a different allowance.**

## 1. What the record said

`/history/usage.jsonl`, conversation `ci-fix-intentic-34251735102`, in eighteen minutes:

| At | `modelRequested` | Outcome |
|---|---|---|
| 18:00:32 | `claude-opus-4-6-thinking` | `No capacity available for model claude-opus-4-6-thinking on the server` |
| 18:05:56 | `gemini-3.1-pro-low` | `rate_limit` · `Individual quota reached… Resets in 65h4m34s` |
| 18:08:08 | `claude-opus-4-6-thinking` | the capacity refusal again |

`modelRequested` is what the wire asked for, so the swap happened in the browser before the send, and the turn
it produced spent a second allowance that was already gone. The Google channel (Antigravity, through
CLIProxyAPI) vends Claude, Gemini and GPT-OSS rows on one provider id, each metered separately, and de-lists a
row while it will not serve it — so `claude-opus-4-6-thinking` simply stopped appearing in `/v1/models`.

## 2. What was there

Three mechanisms, each locally reasonable:

- **`useChat-catalog.ts`** repointed any open chat whose model id was missing from a freshly-read catalog to
  that catalog's `default`. Written for a renamed or retired id, and one-way: nothing put the pick back.
- **`model-catalog.ts`** cached and persisted any non-empty discovery, so the shrunk listing also became the
  last-known-good file.
- **`gemini-provider.ts`** kept a pinned model "while offered, else the catalog default", so even a turn the
  composer still aimed at Opus could run on something else without saying so.
- **`model-order.ts`** made `gemini-3.1-pro-low` the head of the list once Opus was gone, because it carries
  version digits (3.1) and the same model's loud row (`gemini-pro-agent`, "Gemini 3.1 Pro (High)") carries
  none, which reads as older.

Together: capacity dip → thin catalog → composer repointed → auto-continue re-sends → the quiet, cheaper rung
of a model the user did not choose, on its own separate quota.

## 3. What was built

- **A grace window on the catalog** (`ABSENT_FOR_MS`, 30 minutes). A row the live source published inside the
  window and has just stopped naming is kept in the served list, behind the rows it still serves, and persisted
  with them. A dip no longer rewrites what this sandbox believes the account can run; half an hour of silence
  still retires the row. The window is memory, not disk (a provider's stored rows are ids, its live rows are
  whole vendor records, and only the live shape can be re-served), so a daemon restart mid-outage re-derives the
  list from the first live read and the row goes then — which is why the chat's own debt below, and not this
  window, is what actually protects the pin.
- **A borrowed pick, not a decision** (`Conversation.displacedModel`). When a catalog does not offer a chat's
  model, the chat moves to the default and the displaced id is owed back; the next read that lists it puts it
  back. Any pick of the user's own — model, provider, persona card — cancels the debt, and it is persisted with
  the tab so a reload cannot settle the app's substitution as if it were a choice.
- **A refusal instead of a substitution** (`planGeminiTurn`). A pin the channel no longer offers ends the turn
  with `model-unavailable`, which holds the message, reloads the picker and says which model is gone. An absent
  or empty `model` still means the catalog default: that is the wire's own way of saying "whatever this channel
  leads with".
- **A quiet rung sorts under its tier** (`compareModelIds`). An id naming a level below the provider's default
  (`low`, `minimal`, `none`) is a cheaper rung of its tier, not a model of its own, so it is compared after tier
  and before release. The Google channel's default is now Opus while it is listed and Gemini 3.1 Pro (High)
  when it is not.

## 4. What it costs

One `Map` of ids per catalog instance, one extra comparison per model-order compare, one ref per conversation.
No new I/O anywhere: the grace rides the discovery already being made, and the refusal replaces a substitution
that was already computed.

## 5. Options that lose

- **Never repointing, and refusing at send time.** Leaves the picker showing an id the provider does not serve
  and makes every send the place you find out; the borrow does the same work without the dead end.
- **Filing the missing model as refused** (`model-refusals.json`). That store is the provider's own "not on
  your plan" verdict and hides a row for a day — exactly wrong for a model that is back in ten minutes. The
  plan refusal deliberately does not reach it.
- **A fallback ladder for chat turns.** The same argument `allowance-handoff.md` §5 makes for accounts: a
  cross-model move retires the session and spends a different budget, which is a decision the owner makes in
  the picker, not one a capacity dip makes for them.

## 6. How to tell it worked

`modelRequested` and `model` in the usage ledger are equal for every Google-channel turn the tier judge left
alone (an `autoTier: "on"` downgrade is the one honest way for them to differ), or the turn ended
`model-unavailable`. Any other row where they differ is a substitution, and there is no longer code that writes
one.
