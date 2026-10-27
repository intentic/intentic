import type { PlatformRouter } from "./serve";

// THE PUSH RELAY, as a paired phone's wake registers with it (features/capabilities/connect/phoneWake.ts): a device id,
// the secret its wakes are signed with, and the address the platform forwards them to. Nothing is ever forwarded here.
let registered = 0;

export const pushAnswers = {
    register: ({ platform }) => {
        registered += 1;
        const deviceId = `demo-${platform}-${registered}`;
        return { deviceId, secret: `demo-push-secret-${registered}`, url: `https://push.demo.invalid/wake/${deviceId}` };
    },
} satisfies NonNullable<PlatformRouter[`push`]>;
