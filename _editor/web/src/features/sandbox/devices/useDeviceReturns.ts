import { computed, watch } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { agentReturnsPending, settleAgentRuns } from "./runners/deviceWork";

// THE READER THAT ANSWERS AN AGENT'S WAIT, WHEREVER THE READER IS. An update or a restart is over when the machine's
// agent comes back, which only a reading of the machine shows, and by then the device page that pressed it is usually
// gone: the reader went back to the board, or on to a chat. So the shell holds this, and every reading of the device
// list (its own, the Devices tab's poll, a refetch after a press) is checked against what is still waiting
// (deviceWork.ts). It reads the same cached entry the tab does and asks for it only while something waits, so a sandbox
// with nothing in flight pays for nothing.

// Tighter than the tab's own ten seconds: a restarted loop redials within a second or two, and the row's turning mark
// should stop close to when it does. Bounded by the ledger's deadline, after which nothing waits.
const RETURN_POLL_MS = 5_000;

export const watchDeviceReturns = (): void => {
    const pending = computed(agentReturnsPending);
    const { query } = useSandboxQuery({
        ...rpcQuery(`system.devices`),
        enabled: pending,
        refetchInterval: () => (pending.value ? RETURN_POLL_MS : false),
    });
    watch(
        () => query.data.value,
        (list) => {
            if (list !== undefined) {
                settleAgentRuns(list.devices, Date.now());
            }
        },
    );
};
