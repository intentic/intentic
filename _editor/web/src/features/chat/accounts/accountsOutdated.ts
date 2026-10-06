import { computed } from "vue";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";

// A SANDBOX TOO OLD FOR ACCOUNT ROUTING. Every daemon from v1.313 on serves `agent.switchAccount`, and the same release
// judges each account row itself (`state`), names the account a failed turn ran on, and keeps where a conversation runs
// (routingFor). One from before (every release up to v1.312) does none of that, and nothing in the chat rebuilds it from
// what that daemon did send: the picker and the continue card say the sandbox needs an update (SandboxOutdatedNotice.vue)
// and offer only what it serves. Read off the route, never the version: a sandbox built from a checkout says 0.0.0.
export const accountsOutdated = computed(() => !supportsRoute(`agent.switchAccount`));
