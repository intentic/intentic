import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { DEFAULT_PRIVACY_SHIELD } from "@intentic/sandbox-contract/schemas/privacy";

// The privacy shield's policy, as the Privacy page and the data-protection preset both write it, for this page load.
let policy: PrivacyShieldPolicy = DEFAULT_PRIVACY_SHIELD;

export const shieldPolicy = (): PrivacyShieldPolicy => policy;

export const setShieldPolicy = (next: PrivacyShieldPolicy): void => {
    policy = next;
};
