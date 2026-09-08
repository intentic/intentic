// Pure builders for the gate's wiring text, shared by the designer's gate panel and the card badge so the two can't
// drift. The YAML step references `secrets.INTENTIC_GATE_URL` rather than the URL itself, since the URL carries the
// token and a committed credential can't be revoked without deleting the gate.

// Seconds the snippet asks the gate to hold the connection; the route caps any request at three hours.
export const GATE_WAIT_S = 1800;

// Relative path the daemon's gate route (gate.routes.ts) is served on.
export const gatePath = (workflowId: string, token: string): string =>
    `/workflows/${encodeURIComponent(workflowId)}/gate?token=${encodeURIComponent(token)}`;

// GitHub Actions step using the `intentic/gate-action` Marketplace action, not open-coded curl; the action maps
// `blocked` to a non-failing build, not a red one.
export const githubStep = (workflowName: string): string => `- name: ${workflowName}
  uses: intentic/gate-action@v1
  with:
    url: \${{ secrets.INTENTIC_GATE_URL }}`;

// Plain curl for any other CI system; the reply is JSON with `outcome`, `reason`, and `runId`.
export const curlLine = (url: string): string =>
    `curl -sS --max-time ${GATE_WAIT_S + 60} --data-binary "what this pipeline knows: commit, branch, preview URL" "${url}&wait=${GATE_WAIT_S}"`;
