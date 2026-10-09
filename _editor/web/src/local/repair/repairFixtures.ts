import type { LocalRepairHost, LocalRepairMessage, LocalRepairSession } from "../../app/environments/localHost";
import { ref, type Ref } from "vue";

export type RepairFixtureName =
    | `findings`
    | `thinking`
    | `needsApproval`
    | `done`
    | `failed`
    | `signedOut`
    | `offline`
    | `allowanceUsed`;

const tool = (
    name: string,
    state: LocalRepairMessage[`tool`] extends infer T ? (T extends { state: infer S } ? S : never) : never,
    summary: string,
    extra?: { detail?: string; approvalId?: string },
): NonNullable<LocalRepairMessage[`tool`]> => ({
    name,
    state,
    summary,
    detail: extra?.detail,
    approvalId: extra?.approvalId,
});

const sessionOf = (state: LocalRepairSession[`state`], messages: LocalRepairMessage[]): LocalRepairSession => ({
    state,
    messages,
});

const fixtures: Record<RepairFixtureName, LocalRepairSession> = {
    findings: sessionOf(`idle`, [
        {
            id: `a1`,
            role: `assistant`,
            text: `I ran the opening checks. Docker looks fine; your sandbox is not answering.`,
            tool: undefined,
        },
        {
            id: `t1`,
            role: `tool`,
            text: `Check sandbox kind-otter`,
            tool: tool(`doctor`, `done`, `Check sandbox kind-otter`, {
                detail: `{"slug":"kind-otter","report":{"checks":[{"id":"daemon","state":"fail"}]}}`,
            }),
        },
    ]),
    thinking: sessionOf(`thinking`, [
        { id: `u1`, role: `user`, text: `Can you restart it?`, tool: undefined },
    ]),
    needsApproval: sessionOf(`waiting`, [
        {
            id: `t2`,
            role: `tool`,
            text: `Restart sandbox kind-otter`,
            tool: tool(`sandbox_restart`, `needsApproval`, `Restart sandbox kind-otter`, { approvalId: `ok-1` }),
        },
    ]),
    done: sessionOf(`idle`, [
        {
            id: `t3`,
            role: `tool`,
            text: `Restart sandbox kind-otter`,
            tool: tool(`sandbox_restart`, `done`, `Restart sandbox kind-otter`, { detail: `sandbox kind-otter restart started` }),
        },
        { id: `a2`, role: `assistant`, text: `Restart is underway. Give it a minute, then try the workspace again.`, tool: undefined },
    ]),
    failed: sessionOf(`idle`, [
        {
            id: `t4`,
            role: `tool`,
            text: `Check the container engine on this PC`,
            tool: tool(`engine_status`, `failed`, `Check the container engine on this PC`, { detail: `Docker is not running.` }),
        },
    ]),
    signedOut: sessionOf(`signedOut`, [
        {
            id: `t5`,
            role: `tool`,
            text: `Start sandbox kind-otter, which was held`,
            tool: tool(`fix`, `needsApproval`, `Start sandbox kind-otter, which was held`, { approvalId: `fix-1` }),
        },
    ]),
    offline: sessionOf(`offline`, [
        { id: `a3`, role: `assistant`, text: `Repair could not reach the model (offline).`, tool: undefined },
    ]),
    // Sample: an allowance that resets at the next UTC midnight, as the platform's does.
    allowanceUsed: {
        ...sessionOf(`idle`, []),
        allowanceResetsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString(),
    },
};

export const repairFixture = (name: RepairFixtureName): LocalRepairHost => {
    const session: Ref<LocalRepairSession> = ref(fixtures[name]);
    return {
        session,
        start: async () => {
            session.value = fixtures[name];
        },
        send: async () => undefined,
        answer: async () => undefined,
        reset: async () => {
            session.value = { state: `idle`, messages: [] };
        },
    };
};
