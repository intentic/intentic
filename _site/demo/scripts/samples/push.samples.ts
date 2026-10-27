import type { GroupSamples } from "./context.ts";

// A browser registers, is tested, then leaves again, so the run ends with no device registered.
export const pushSamples: GroupSamples<`push`> = () => ({
    config: { id: `https://push.smoke.invalid/send/smoke` },
    subscribe: { kind: `webpush`, endpoint: `https://push.smoke.invalid/send/smoke`, keys: { p256dh: `smoke-p256dh`, auth: `smoke-auth` } },
    test: undefined,
    unsubscribe: { id: `https://push.smoke.invalid/send/smoke` },
});
