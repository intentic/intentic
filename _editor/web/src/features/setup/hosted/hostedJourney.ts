import { z } from "zod";
import { HOSTED_TIER_IDS, type HostedTierId } from "@intentic/constants";
import { hostedStartKey, removeStoredValue, storedJson, storeJson } from "../../../app/storage/browserStorage";

const JourneySchema = z.object({ requestId: z.uuid(), sandboxId: z.string().optional(), tier: z.enum(HOSTED_TIER_IDS).optional() });

// Nothing is persisted until Create is pressed. The UUID is an idempotency key, never a sandbox credential.
export const hostedJourney = (accountId: string) => {
    const key = hostedStartKey(accountId);
    return {
        read: () => storedJson(key, JourneySchema),
        request: (): string => {
            const current = storedJson(key, JourneySchema);
            if (current !== undefined) {
                return current.requestId;
            }
            const requestId = crypto.randomUUID();
            storeJson(key, { requestId });
            return requestId;
        },
        remember: (requestId: string, sandboxId: string, tier: HostedTierId): void => storeJson(key, { requestId, sandboxId, tier }),
        reset: (): void => removeStoredValue(key),
    };
};

export type HostedJourney = ReturnType<typeof hostedJourney>;
