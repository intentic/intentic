import type { GroupSamples } from "./context.ts";

// Fired on the visitor chat, which asks a person first, so the fire is held (`held-visitor-chat-1`, the demo's first
// wake) and then approved; the removal goes last, since the run and the switch need the automation still there.
export const automationsSamples: GroupSamples<`automations`> = ({ automation, held }) => ({
    list: undefined,
    catalog: undefined,
    check: { source: { kind: `npm`, package: `pg`, range: `>=9.0.0` } },
    pendingList: undefined,
    upsert: automation,
    setEnabled: { id: automation.id, enabled: automation.enabled },
    rotateToken: { id: `pipeline-failed` },
    run: { id: `visitor-chat` },
    approve: { id: `held-visitor-chat-1` },
    reject: { id: held.id },
    senders: { provider: `discord` },
    remove: { id: automation.id },
});
