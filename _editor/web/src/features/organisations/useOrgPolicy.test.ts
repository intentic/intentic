// The organisation policy is read only from a daemon that serves it. Released daemons up to 1.337.0 have no
// `org.policy`, and every hub open used to ask one anyway and show the error it came back as, which quoted the route.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type OrgPolicyState, SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { type MaybeRefOrGetter, ref, toValue } from "vue";

const asked: { enabled?: MaybeRefOrGetter<boolean> }[] = [];
const answer = ref<OrgPolicyState | undefined>(undefined);
jest.mock(`../../client/sandbox/useSandboxQuery`, () => ({
    useSandboxQuery: (options: { enabled?: MaybeRefOrGetter<boolean> }) => {
        asked.push(options);
        return { query: { data: answer } };
    },
}));

const { setDaemonRoutes } = await import("../../client/sandbox/useDaemonRoutes");
const { useOrgPolicy } = await import("./useOrgPolicy");

const enabled = (): boolean => toValue(asked.at(-1)?.enabled) !== false;

beforeEach(() => {
    resetSandboxScope();
    asked.length = 0;
    answer.value = undefined;
});

it(`never asks a daemon whose hello leaves the route out, and reads it as unbound`, () => {
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `org.policy`));
    const { policy, modeOf } = useOrgPolicy();
    expect(enabled()).toBe(false);
    expect(policy.value).toBeUndefined();
    expect(modeOf(`models`)).toBe(`open`);
});

it(`asks a daemon that serves it, and one that has not said what it serves`, () => {
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES]);
    useOrgPolicy();
    expect(enabled()).toBe(true);
    resetSandboxScope();
    useOrgPolicy();
    expect(enabled()).toBe(true);
});

// The privacy shield, guardrails and retention pages write the Agent section's routes (the shield's policy, the safety
// policy, settings), so the Agent lock holds them as it held them when they were parts of the Agent page.
it(`holds the pages that moved out of Agent with the Agent lock`, () => {
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES]);
    answer.value = { bound: true, receivedAt: `2026-10-16T00:00:00Z`, policy: { orgId: `org-1`, orgName: `Gmina`, version: 1, sections: { agent: `hidden` } } };
    const { modeOf, hidden } = useOrgPolicy();
    for (const slug of [`agent`, `privacy-shield`, `guardrails`, `retention`]) {
        expect(modeOf(slug)).toBe(`hidden`);
        expect(hidden.value.has(slug)).toBe(true);
    }
    expect(modeOf(`activity`)).toBe(`open`);
    expect(modeOf(`data-protection`)).toBe(`open`);
});
