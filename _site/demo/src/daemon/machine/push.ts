import { channelId, type PushChannel, type PushConfig } from "@intentic/sandbox-contract/schemas/push";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { pause } from "./machineKit";

// Notifications to the owner's devices (the daemon's push/): the sandbox's public key, the devices registered for it,
// and the test that proves the chain. A registered device is remembered for the page, so the switch reads back on.

// The sandbox's VAPID public key: a real P-256 point, so a browser's own subscribe accepts it.
const PUBLIC_KEY = `BIWnN1jkhJQQa1I7tKF7rVTedRJantCMy-u29XCWnj7Mjqf-Zal-CaPmZAoz_Gd7rZbgZZj4KWCgH-8-jpC1y80`;
// A test goes through the push service and back, a round trip of a second or so.
const TEST_MS = 1_100;

const channels = new Map<string, PushChannel>();

export const pushConfig = (id: string | undefined): PushConfig => ({ publicKey: PUBLIC_KEY, subscribed: id !== undefined && channels.has(id) });

export const subscribePush = (channel: PushChannel): SandboxHandlerOutput<`push`, `subscribe`> => {
    channels.set(channelId(channel), channel);
    return { ok: true };
};

export const unsubscribePush = (id: string): SandboxHandlerOutput<`push`, `unsubscribe`> => {
    channels.delete(id);
    return { ok: true };
};

/** Sends the test to every registered device and counts those that took it, which here is every one. */
export const testPush = async (): Promise<SandboxHandlerOutput<`push`, `test`>> => {
    await pause(TEST_MS);
    return { delivered: channels.size };
};
