# Intentic Agent Gate

Run your [intentic](https://intentic.dev) agent from GitHub Actions: block a workflow on an agent-judged
release gate, or wake the agent with the event that just happened — one step, one secret.

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

- **pass** — the step is green.
- **fail** — the step is red, with the gate's own reason as the error.
- **blocked** — the gate could not judge. The step stays **green** by default, because a check that breaks
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
full event payload — the same JSON a GitHub webhook would deliver — and moves on without waiting:

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

## Inputs

| input | default | |
| --- | --- | --- |
| `url` | *(required)* | The door URL from your sandbox — a release gate or an automation webhook. Store it as a repository secret: it carries its own token. |
| `request` | composed | What to tell the agent. Defaults to the commit/branch/PR line for a gate, and to the event payload for an automation. |
| `wait` | `1800` | Seconds a gate holds the connection before the run is stopped (server caps at 3 hours). |
| `blocked-as` | `success` | What a `blocked` verdict does to the step: `success` or `failure`. |

## Outputs

| output | |
| --- | --- |
| `outcome` | `pass`, `fail` or `blocked` (gate door only). |
| `reason` | The verdict's own sentence. |
| `run-id` | The run's id inside your sandbox, where the full transcript lives. |
| `value` | The raw judged value, when the gated workflow produced one. |

A step that fails for any other reason — wrong token, no such gate, the gate's daily run ceiling, network —
says so in its error message instead of pretending to be a verdict: that failure needs whoever owns the
pipeline, not whoever owns the product.

## Where the URL comes from

In your sandbox: **Workflows → your workflow → Gate** for a release gate, or **Automations → your event
automation** for a webhook. Both URLs embed a token minted for that door alone; deleting the gate or the
automation revokes it.

This repository is a build artifact — the action is developed and tested in
[intentic/intentic](https://github.com/intentic/intentic) and synced here on every release.
