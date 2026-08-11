import { expect, test } from "vitest";
import { curlLine, GATE_WAIT_S, gatePath, githubStep } from "./gateSnippets";

/* The snippets are the one part of this feature that runs somewhere we cannot see — inside a stranger's
 * pipeline, pasted once and read never — so what they must get right is asserted rather than eyeballed. */

test("the path names the gate route and carries the token as its query", () => {
    expect(gatePath(`wf-1`, `tok_abc`)).toBe(`/workflows/wf-1/gate?token=tok_abc`);
    // An id with a reserved character must not break the URL it lands in.
    expect(gatePath(`wf/odd`, `t`)).toBe(`/workflows/wf%2Fodd/gate?token=t`);
});

test("the GitHub step uses the Marketplace action off a secret, never an inlined token", () => {
    const step = githubStep(`Release gate`);
    // The secret, not the URL: a token pasted into a committed file is a credential in the repo's history.
    expect(step).toContain(`url: \${{ secrets.INTENTIC_GATE_URL }}`);
    expect(step).not.toContain(`http`);
    // The action owns the verdict-to-exit mapping AND the default request; the snippet must carry neither.
    expect(step).toContain(`uses: intentic/gate-action@v1`);
    expect(step).not.toContain(`github.sha`);
});

test("the curl line rides the URL's own token and asks for the same wait", () => {
    const line = curlLine(`https://sandbox.example/workflows/wf-1/gate?token=t`);
    expect(line).toContain(`?token=t&wait=${GATE_WAIT_S}`);
    expect(line).toContain(`--max-time ${GATE_WAIT_S + 60}`);
});
