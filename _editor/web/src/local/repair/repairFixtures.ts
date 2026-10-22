import type { LocalRepairHost, LocalRepairMessage, LocalRepairSession } from "../../app/environments/localHost";
import { ref, type Ref } from "vue";

export type RepairFixtureName =
    | `empty`
    | `checking`
    | `healthy`
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

// Sample output in the shapes `ic` prints them (ic: sandbox/fix/report.rs `result_line`, engine/commands.rs
// `status_json`), so the kit draws what the page reads rather than what it was written against.
const doctorLine = (slug: string, outcome: string, checks: readonly Record<string, string>[]): string =>
    JSON.stringify({ slug, report: { source: `app`, machine: `ada-pc`, os: `windows`, stage: `done`, outcome, checks } });
const passing = (...ids: readonly [string, string][]): Record<string, string>[] => ids.map(([id, label]) => ({ id, label, state: `ok` }));
const DOCTOR_BROKEN = [
    `intentic-fix: {"slug":"kind-otter","stage":"checking","doing":"Checking the container"}`,
    doctorLine(`kind-otter`, `needs-you`, [
        ...passing([`docker`, `Docker engine`], [`wsl`, `WSL`], [`disk`, `Disk space`], [`container`, `Sandbox container`]),
        {
            id: `daemon`,
            label: `Daemon health`,
            state: `fail`,
            problem: `the sandbox's daemon does not answer on its health port.`,
            remedy: `ic sandbox restart kind-otter`,
            fix: `consent`,
        },
        { id: `registration`, label: `Platform registration`, state: `skip` },
        { id: `tunnel`, label: `Public URL`, state: `skip` },
    ]),
    doctorLine(`brave-heron`, `healthy`, [
        ...passing([`docker`, `Docker engine`], [`container`, `Sandbox container`], [`daemon`, `Daemon health`], [`tunnel`, `Public URL`]),
        { id: `disk`, label: `Disk space`, state: `warn`, problem: `12 GiB free on C:, under the 20 GiB a rebuild wants.` },
    ]),
].join(`\n`);
const DOCTOR_HEALTHY = doctorLine(
    `kind-otter`,
    `healthy`,
    passing([`docker`, `Docker engine`], [`wsl`, `WSL`], [`disk`, `Disk space`], [`container`, `Sandbox container`], [`daemon`, `Daemon health`], [`registration`, `Platform registration`], [`tunnel`, `Public URL`]),
);
const ENGINE = JSON.stringify({ engine: `intentic`, chosen: `intentic`, installed: true, running: true, version: `0.9.4`, active: true, held: false, distro: `intentic-engine` });

const checksRun = (doctor: string): LocalRepairMessage[] => [
    { id: `t-doctor`, role: `tool`, text: `Check every sandbox on this PC`, tool: tool(`doctor`, `done`, `Check every sandbox on this PC`, { detail: doctor }) },
    { id: `t-engine`, role: `tool`, text: `Check the container engine on this PC`, tool: tool(`engine_status`, `done`, `Check the container engine on this PC`, { detail: ENGINE }) },
];

const fixtures: Record<RepairFixtureName, LocalRepairSession> = {
    empty: sessionOf(`idle`, []),
    checking: sessionOf(`thinking`, [
        { id: `t-doctor`, role: `tool`, text: `Check every sandbox on this PC`, tool: tool(`doctor`, `done`, `Check every sandbox on this PC`, { detail: DOCTOR_BROKEN }) },
        { id: `t-engine`, role: `tool`, text: `Check the container engine on this PC`, tool: tool(`engine_status`, `running`, `Check the container engine on this PC`) },
    ]),
    healthy: sessionOf(`idle`, [
        ...checksRun(DOCTOR_HEALTHY),
        { id: `a0`, role: `assistant`, text: `Both checks came back clean: **kind-otter** answers and the engine is running.`, tool: undefined },
    ]),
    findings: sessionOf(`idle`, [
        ...checksRun(DOCTOR_BROKEN),
        {
            id: `a1`,
            role: `assistant`,
            text: `The engine is fine, but **kind-otter**'s daemon is not answering. A restart usually brings it back; it takes about a minute.`,
            tool: undefined,
        },
    ]),
    thinking: sessionOf(`thinking`, [
        ...checksRun(DOCTOR_BROKEN),
        { id: `u1`, role: `user`, text: `Can you restart it?`, tool: undefined },
    ]),
    needsApproval: sessionOf(`waiting`, [
        ...checksRun(DOCTOR_BROKEN),
        { id: `u2`, role: `user`, text: `Yes, restart it please.`, tool: undefined },
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
        ...checksRun(DOCTOR_BROKEN),
        {
            id: `t5`,
            role: `tool`,
            text: `Restart sandbox kind-otter: its daemon does not answer`,
            tool: tool(`fix`, `needsApproval`, `Restart sandbox kind-otter: its daemon does not answer`, { approvalId: `fix-1` }),
        },
    ]),
    offline: sessionOf(`offline`, [
        { id: `a3`, role: `assistant`, text: `Repair could not reach the model (offline).`, tool: undefined },
    ]),
    // Sample: an allowance that resets at the next UTC midnight, as the platform's does.
    allowanceUsed: {
        ...sessionOf(`idle`, checksRun(DOCTOR_BROKEN)),
        allowanceResetsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString(),
    },
};

export const repairFixture = (name: RepairFixtureName): LocalRepairHost => {
    const session: Ref<LocalRepairSession> = ref(fixtures[name]);
    return {
        session,
        start: async () => {
            session.value = name === `empty` ? fixtures.checking : fixtures[name];
        },
        send: async () => undefined,
        answer: async () => undefined,
        reset: async () => {
            session.value = { state: `idle`, messages: [] };
        },
    };
};
