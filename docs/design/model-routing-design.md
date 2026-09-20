# Auto — choosing the model a conversation runs on

One question, asked once, on the message a chat opens with: **which model should this whole conversation run
on?** Pick the Auto row in the model picker and a model reads that first message, answers with a provider, a
model, an effort and an account drawn from what is connected and still has allowance, and the chat wears the
answer exactly as a hand-made pick. From turn two the model is an ordinary pick its owner holds.

This replaces a per-turn complexity router that this repo built, measured and removed; §6 says why, because
the reasons are worth not re-deriving.

---

## 1. Why the question is asked at the conversation, not at the turn

The two facts that decide which model a piece of work wants are **what the work will turn into** and **how
much allowance each account has left**. Neither is in the words of one prompt. A per-turn scorer reading the
prompt alone can only ever move a turn down a rung of the provider the user already picked — it cannot choose
across providers, it cannot see an account at cap, and it is answering after the decision that mattered was
already made.

Asking once, at the opening message, is also the only moment where the answer is free to be anything: nothing
has run, no session exists to retire, and the user has just written the clearest statement of the work they
will ever write.

**One call, amortised over a conversation.** The objection to LLM routing is paying a serial model hop on
every turn to make a decision worth a fraction of a cent. That objection does not reach this: it is one cheap
call spread over every turn that follows, making a decision no free scorer could make at all.

## 2. It is a classification over an offered list, never a free choice

`model-offer.ts` (contract, pure) builds the two blocks the judge sees — runnable models with their effort
ladders, and each account with how much allowance it has left — and reads the reply back against them.

- A reply naming a model **not on the list** is *unusable*, so the role ladder steps to its next rung rather
  than running an id no provider has.
- An unrecognised effort or account is dropped and the model it came with is kept: those are refinements, and
  the turn's own defaults answer for them correctly.

**Allowances are a hard filter as well as context.** `auto-offer.ts` drops a model whose every connected
account is at cap *before the judge sees it* — the same reading `role-model-quota.ts` steps a helper rung over
— so a pick cannot be one the provider would refuse. An **unmeasured** account counts as headroom, not as
spent: silence is not evidence of a full pool, and treating it as one would hide most of the catalog in a
sandbox nobody has measured.

**Endpoints and the free trial are left out entirely.** The premise is choosing against a readable allowance
and neither publishes one; the trial is additionally a disclosed bargain its owner opts into rather than one a
router moves them to.

## 3. Nothing blocks a send

No offer, an unset role, a spent chain, a deadline, a reply naming nothing: each resolves to "nothing chosen",
the chat runs on the pick it already had, and the transcript notice says which of those happened. The reading
is always drawn — a spinning row rewritten in place with the verdict and the model that gave it — because **a
model call the owner cannot see is a bill they cannot question.**

The browser's wait (`SEND_WAIT_MS`) is deliberately longer than the daemon's own deadline
(`ROUTE_DEADLINE_MS`), so a slow reading is given up by the side that can say *why*, not by a timer.

## 4. Where it is offered, and why only there

The Auto row is offered on a chat of this sandbox's **with nothing sent yet**, which is exactly the condition
`modelRoute.ts` requires to do the reading. It is gated by no setting at all:

- Which model a chat runs on is a **per-chat** question. A mode that only appears once you have found a switch
  on a settings page is a mode nobody finds.
- What a sandbox *configures* is not whether Auto is offered but how it reads: which model does the reading — the
  `model-router` job under Settings › Models, an ordered list like every other job, so one spent account does not take
  it down — and what that model is told to weigh (`autoModelGuidance`, the same page). The guidance is spliced in ahead
  of the offer and the reply contract, so an owner can change the judgement without being able to break the answer:
  a model it names that is not on the offered list is still read back as no pick at all.

While Auto is armed the picker's footer answers **nothing** about the model underneath. That model is only the
fallback if the reading never lands; drawing its accounts, its effort chips and its runtime's limits there
would be answering questions about the wrong model. The composer's pill says *Auto*, for the same reason: a
control whose press leaves the screen unchanged reads as a control that refused.

## 5. It is recorded, so it can be argued with

The turn whose model the judge chose carries `UsageTurn.autoPicked`, and that one turn only. A later row of the
same conversation naming a different model is **the user overruling the pick** — the escalation rate this
feature has to be able to answer for, computable from the ledger without a schema change whenever somebody
comes to draw it.

## 6. What was removed, and why it is not coming back

An earlier build shipped a per-turn complexity judge: a pure keyword-and-weights score over the prompt
(`prompt-complexity.ts`), a cheaper rung of the same provider (`fast-tier.ts`), a three-state sandbox setting
(off / measure / on), an eagerness dial, a per-conversation veto, a composer chip and a savings readout. All of
it is gone. The reasons, in the order they matter:

1. **It answered the same question twice, worse.** Once Auto existed, the settings enum had two mutually
   exclusive states for one question — "let something pick the model" — and the second one could only ever
   move a turn one rung inside a provider already chosen.
2. **The interesting case was the one it was structurally barred from.** Everything a per-turn scorer could
   save was bounded by the gap between two rungs of one vendor's ladder. Choosing the conversation's model
   across providers, efforts and accounts is a larger decision made once, for one cheap call.
3. **It cost more in surface than it saved in tokens.** A frame, a ledger column family, a registry field, a
   per-conversation veto, a transcript notice with its own opt-out, a composer chip, a report and a settings
   section — all to move some turns down one rung.
4. **The UX could not be made honest.** "Cheaper turns" and "Auto model" sat in one segmented control because
   the code made them exclusive, so picking a model-choice mode meant visiting a section about saving money on
   turns. Splitting the control would have meant maintaining both mechanisms; the measurement had already said
   which one to keep.

**What is worth remembering from it.** Two findings survive their mechanism. A pick whose family carries no
tier word must never be "downgraded" — nothing can be shown to be cheaper than an unknown. And the signal to
build any future calibration around is already recordable: *the user bumps the model right after a routed
turn* is the product telling you, from inside itself, that the router was wrong, in the direction that matters.

## 7. Where the pieces live

| Piece | Home |
| --- | --- |
| The prompt, the deadline, the reply | `sandbox/src/agent/prompt/model-router.ts` |
| What may be chosen from, and the allowance filter | `sandbox/src/agent/models/auto-offer.ts` |
| The offered list's shape, and reading a reply against it | `sandbox-contract/src/models/model-offer.ts` |
| Which model does the reading | `model-roles.ts` (`model-router`) → Settings › Models |
| What the owner tells it to weigh | `settings.ts` (`autoModelGuidance`) → `AgentModels.vue` |
| The Auto row, the tick and the footer | `ModelPicker.vue` (lead rows) / `ChatModelPicker.vue` |
| The armed state, where it is legible | `ComposerModelPill.vue` |
| The send-time wait, the notice, wearing the answer | `modelRoute.ts` → `Conversation.wearModel` |
| The one-turn mark | `AgentTurn.autoPicked` → `UsageTurn.autoPicked` |

**The precedent, copied rather than invented.** `persona-router.ts` / `personaRoute.ts` already does all of
this for a different question — one classification call on the opening message, never on a draft, the send held
under a deadline, a spinning notice settled in place, the answer applied through `wearModel`. Auto is its
sibling, and any change to how one of them behaves should be weighed against the other. A persona that wears
its own model wins: `ChatPane` chains persona routing first and `wearModel` disarms Auto, so a card naming a
ladder is an explicit instruction Auto stands down for rather than overrules.

## Sources

- [Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey](https://arxiv.org/abs/2603.04445)
- [Rethinking Predictive Modeling for LLM Routing: When Simple kNN Beats Complex Learned Routers](https://arxiv.org/abs/2505.12601)
- [Is Escalation Worth It? A Decision-Theoretic Characterization of LLM Cascades](https://arxiv.org/abs/2605.06350)
- [SWE-Router: Routing in Multi-turn Agentic Software Engineering Tasks](https://arxiv.org/abs/2607.00053)
- [Routesplain: Towards Faithful and Intervenable Routing for Software-related Tasks](https://arxiv.org/abs/2511.09373) (COLM 2026)
- [RouterBench: A Benchmark for Multi-LLM Routing System](https://arxiv.org/abs/2403.12031)
- [LLMRouterBench: A Massive Benchmark and Unified Framework for LLM Routing](https://arxiv.org/abs/2601.07206)
- [TwinRouterBench: Fast Static and Live Dynamic Evaluation for Realistic Agentic LLM Routing](https://arxiv.org/abs/2605.18859)
- [Unsolvability Ceiling in Multi-LLM Routing: An Empirical Study of Evaluation Artifacts](https://arxiv.org/abs/2605.07395)
- [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665) · [framework](https://github.com/lm-sys/RouteLLM) · [LMSYS write-up](https://www.lmsys.org/blog/2024-07-01-routellm/)
- [BEST-Route: Efficient LLM query routing via multi-sampling](https://arxiv.org/abs/2506.22716) · [code](https://github.com/microsoft/best-route-llm)
- [Arch-Router: Aligning LLM Routing with Human Preferences](https://arxiv.org/abs/2506.16655) · [weights](https://huggingface.co/katanemo/Arch-Router-1.5B)
- [Efficient Multi-Model Orchestration for Self-Hosted Large Language Models](https://arxiv.org/abs/2512.22402)
- [LiteLLM auto-routing docs](https://docs.litellm.ai/docs/proxy/auto_routing)
