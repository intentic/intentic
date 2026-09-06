# Intentic Agent Gate

Run your [intentic](https://intentic.dev) agent from GitHub Actions: block a workflow on an agent-judged
release gate, or wake the agent with the event that just happened: one step, one secret.

```yaml
- uses: intentic/gate-action@v1
  with:
    url: ${{ secrets.INTENTIC_URL }}
```

The `url` is a door your sandbox hands you, token included. Which door it is decides what the step does:

## The release gate

Declare a gate on a workflow in your sandbox's designer and copy its URL into a repository secret. The step
POSTs what the pipeline knows, holds the connection while your agent runs the gated workflow against the
change, and finishes on the verdict:

- **pass**: the step is green.
- **fail**: the step is red, with the gate's own reason as the error.
- **blocked**: the gate could not judge. The step stays **green** by default, because a check that breaks
  must not read as the product breaking; set `blocked-as: failure` if you want it red anyway. Either way the
  reason lands as an annotation, so a green run still shows that the gate never judged it.

Without a `request`, the step sends the commit, branch and pull-request link it is running for. With one, it
sends exactly what you wrote:

```yaml
- uses: intentic/gate-action@v1
  with:
    url: ${{ secrets.INTENTIC_GATE_URL }}
    request: "commit ${{ github.sha }} — preview at ${{ steps.deploy.outputs.url }}"
    wait: 2700
```

The verdict comes back as step outputs, so anything can chain on it:

```yaml
- uses: intentic/gate-action@v1
  id: gate
  with:
    url: ${{ secrets.INTENTIC_GATE_URL }}
- if: ${{ always() && steps.gate.outputs.reason != '' }}
  run: gh pr comment ${{ github.event.number }} --body "${{ steps.gate.outputs.reason }}"
  env:
    GH_TOKEN: ${{ github.token }}
```

## Waking an automation

Point the same step at an event automation's webhook URL instead, and it wakes your agent with the workflow's
full event payload (the same JSON a GitHub webhook would deliver) and moves on without waiting:

```yaml
on:
  issues:
    types: [opened]
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: intentic/gate-action@v1
        with:
          url: ${{ secrets.INTENTIC_AUTOMATION_URL }}
```

Your agent keeps working after this workflow ends; the run and its conversation live in your sandbox.

## Driving the agent

Mint an API token in your sandbox under **Sandbox → Access → API tokens** at `drive` scope (or `land`, to
merge as well) and store it as a repository secret. With a token the `url` is the sandbox's own address, which
is not a secret, and the step drives the agent directly:

```yaml
- uses: intentic/gate-action@v1
  with:
    url: https://sandbox-….intentic.dev
    token: ${{ secrets.INTENTIC_TOKEN }}
    prompt: "Review this change: ${{ github.event.pull_request.html_url }}"
```

The turn runs in its own conversation and branch inside the sandbox (one per workflow run, so a re-run continues
it), and the step waits for it to settle:

- **completed**: green. `summary` is the conversation's title; `branch` is where the work sits.
- **parked**: the agent asked a person for something (a plan to approve, a question, a permission). The step is
  red with a warning naming the card; open the conversation in your sandbox to answer it.
- **failed**: red, with the sentence the turn died on.
- **timeout**: the deadline decided, not the work; exit 2, and the agent keeps working in the sandbox.

`land: true` merges the branch into the sandbox's main tree once the turn completes (a `land`-scoped token), and
`landed` says whether the whole change applied.

## Inputs

| input | default | |
| --- | --- | --- |
| `url` | *(required)* | The door URL from your sandbox, a release gate or an automation webhook. Store it as a repository secret: it carries its own token, which the step sends as a bearer header rather than in the address it dials. With `token`, the sandbox's own address instead. |
| `token` | | A control token from Sandbox → Access → API tokens. Selects the run: the step drives the agent with `prompt`. Store it as a repository secret. |
| `prompt` | | What to ask the agent, for a run. |
| `agent` | the sandbox's | Which agent runs the prompt (`claude`, `codex`, …). |
| `land` | `false` | For a run: merge the branch into the main tree once the turn completes. Needs a `land`-scoped token. |
| `request` | composed | What to tell the agent at a door. Defaults to the commit/branch/PR line for a gate, and to the event payload for an automation. |
| `wait` | `1800` | Seconds a gate holds the connection, or a run is waited on, before the step gives up (the server caps a gate at 3 hours). |
| `blocked-as` | `success` | What a `blocked` verdict does to the step: `success` or `failure`. |

## Outputs

| output | |
| --- | --- |
| `outcome` | `pass`, `fail` or `blocked` (gate door only). |
| `reason` | The verdict's own sentence. |
| `run-id` | The run's id inside your sandbox, where the full transcript lives. |
| `value` | The raw judged value, when the gated workflow produced one. |
| `status` | How a run ended: `completed`, `parked`, `failed` or `timeout` (run only). |
| `conversation-id` | The conversation the run opened in your sandbox (run only). |
| `branch` | The branch the run worked on, `agent/<conversation-id>` (run only). |
| `summary` | The run's own account: its title, the sentence it failed on, or the card it parked on. |
| `landed` | Whether the run's branch was merged, when `land` was asked for. |

A step that fails for any other reason: wrong token, no such gate, the gate's daily run ceiling, network:
says so in its error message instead of pretending to be a verdict: that failure needs whoever owns the
pipeline, not whoever owns the product.

## Where the URL comes from

In your sandbox: **Workflows → your workflow → Gate** for a release gate, or **Automations → your event
automation** for a webhook. Both URLs embed a token minted for that door alone; deleting the gate or the
automation revokes it, and **Rotate** on either mints a new one. An API token for driving the agent is minted
under **Sandbox → Access → API tokens**, where every token against the sandbox is listed and revoked.

This repository is a build artifact: the action is developed and tested in
[intentic/intentic](https://github.com/intentic/intentic) and synced here on every release.
