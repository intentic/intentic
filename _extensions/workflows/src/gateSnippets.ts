/* THE GATE'S WIRING, AS TEXT A PIPELINE CAN CARRY — pure builders shared by the designer's gate panel and the
 * card badge, so the two surfaces cannot drift apart on the one string a pipeline is actually taught.
 *
 * WHY THE YAML NAMES A SECRET AND NOT THE URL. The URL carries the token and the token is the whole auth:
 * pasted literally into a workflow file it would be committed, and a committed credential forces the one
 * revocation this design has (delete the gate) on everyone who ever cloned the repo. So the copyable step
 * reads `secrets.INTENTIC_GATE_URL`, and the URL itself is copied separately — into the repo's secret store,
 * once. */

// How long the snippet asks the gate to hold the connection, in seconds. Thirty minutes covers a real
// acceptance sweep and still loses to most CI job timeouts; the route caps whatever is asked at three hours.
export const GATE_WAIT_S = 1800;

// The route the daemon serves the gate on (gate.routes.ts), relative to its public origin.
export const gatePath = (workflowId: string, token: string): string =>
    `/workflows/${encodeURIComponent(workflowId)}/gate?token=${encodeURIComponent(token)}`;

/* One copy-paste GitHub Actions step, running the Marketplace action (intentic/gate-action, built in
 * _sandbox/gate-action) rather than open-coded curl: the action owns the verdict-to-exit mapping — `pass`
 * green, `fail` red, `blocked` NOT a red build, because "the check could not judge" must never read as "the
 * product is broken" (the distinction gate.routes.ts exists to keep) — and twelve lines of shell here would
 * be a second copy of it to drift. No request either: the action composes the commit/branch/PR line from the
 * workflow's own context, which is why the snippet is two lines instead of a template. */
export const githubStep = (workflowName: string): string => `- name: ${workflowName}
  uses: intentic/gate-action@v1
  with:
    url: \${{ secrets.INTENTIC_GATE_URL }}`;

// The same call with nothing around it, for every other CI system: the answer is one JSON object —
// `outcome` (pass | fail | blocked), `reason`, `runId` — and the pipeline maps outcome to its own exit.
export const curlLine = (url: string): string =>
    `curl -sS --max-time ${GATE_WAIT_S + 60} --data-binary "what this pipeline knows: commit, branch, preview URL" "${url}&wait=${GATE_WAIT_S}"`;
