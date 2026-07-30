import type { GateStatus, GateVerdict } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";

/* What the push guardrail says, and — the half worth guarding hardest — when it says nothing at all. The two
 * failure directions are not symmetric but both are fatal: a guardrail that speaks up over a green tree gets
 * muscle-memoried away within a week, and one that stays quiet over a red one is the reason the failure reaches
 * CI in the first place.
 *
 * The module's siblings are stubbed because importing it otherwise pulls the sandbox client and, behind it,
 * environment.ts's `window.env` read — the same reason the other composable suites here stub them. `pushObjection`
 * itself is a pure function of a verdict and touches none of it. */
vi.mock("../queryPersistence", () => ({ queryClient: { invalidateQueries: () => {} } }));
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: () => Promise.resolve({}) }));
vi.mock("../sandbox/useSandbox", () => ({ sandboxKey: (...parts: string[]) => parts }));
vi.mock("../sandbox/useSandboxQuery", () => ({ useSandboxQuery: () => ({ query: { data: { value: undefined } }, error: { value: undefined } }) }));

const { pushObjection } = await import("./useGate");

const verdict = (status: GateStatus, over: Partial<GateVerdict> = {}): GateVerdict => ({
    status,
    command: `pnpm test`,
    output: ``,
    fingerprint: `abc`,
    stale: false,
    implicated: [],
    ...over,
});

test("a fresh pass raises no objection", () => {
    expect(pushObjection(verdict(`passed`))).toBeUndefined();
});

// The gate switched off has no opinion to offer, and inventing one would make configuring a command feel like a
// trap. An empty `command` is how the daemon reports "off", whatever else is on disk.
test("the gate switched off raises no objection, whatever the status says", () => {
    expect(pushObjection(verdict(`failed`, { command: `` }))).toBeUndefined();
    expect(pushObjection(verdict(`idle`, { command: `` }))).toBeUndefined();
});

// The reason the fingerprint rewrite mattered: a pass that no longer describes the tree in hand is not a pass.
test("a stale pass objects, because it no longer describes this tree", () => {
    expect(pushObjection(verdict(`passed`, { stale: true }))).toContain(`changed since`);
});

test("every non-passing state objects and names the command", () => {
    for (const status of [`idle`, `armed`, `running`, `failed`, `cancelled`, `error`] as const satisfies readonly GateStatus[]) {
        const objection = pushObjection(verdict(status));
        expect(objection, status).toBeDefined();
        expect(objection, status).toContain(`pnpm test`);
    }
});

// A timeout must not read as "tests failed" here either: nothing was learned about the code, and a user deciding
// whether to push deserves the difference between a failing assertion and a suite that never finished.
test("a timed-out failure says it never finished rather than that it failed an assertion", () => {
    expect(pushObjection(verdict(`failed`, { timedOut: true }))).toContain(`never finished`);
    expect(pushObjection(verdict(`failed`))).toContain(`failed`);
});

// A stale FAILURE is still a failure worth hearing about: `stale` reverses the meaning of a pass and nothing
// else, so it must not be allowed to soften any other state.
test("a stale failure still objects as a failure", () => {
    expect(pushObjection(verdict(`failed`, { stale: true }))).toContain(`failed`);
});
