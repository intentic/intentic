import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy, PrivacyShieldPolicySchema } from "@intentic/sandbox-contract";
import { mapValue } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// The owner's privacy shield policy, stored beside the credential gates and host guards (mode 0600, off the workspace)
// for the same reason they are: `.intentic/config/` is agent-editable, and a turn must not be able to switch off the
// shield it is held to. Read fresh on every request and every turn, so a change holds from the next model call.

export const privacyShieldDocument = defineDocument({
    root: "auth",
    path: "privacy-shield.json",
    schema: PrivacyShieldPolicySchema,
    history: [
        // 2026-10-01: images are always sent, their personal data painted over; holding every image back and sending its
        // read text instead both became that.
        mapValue("images", { withhold: "mask", read: "mask" }),
    ],
});

export interface PrivacyPolicyStore {
    // The policy in force. Throws when the file exists but cannot be read: reading it as the default (off) would turn
    // the shield off without anybody deciding to.
    readonly get: () => Promise<PrivacyShieldPolicy>;
    readonly set: (policy: PrivacyShieldPolicy) => Promise<void>;
}

export class PrivacyPolicyUnreadableError extends Error {
    constructor(path: string, detail: string) {
        super(`the privacy shield's policy at ${path} could not be read (${detail}); fix or remove it before any model request can be shielded`);
        this.name = "PrivacyPolicyUnreadableError";
    }
}

export const filePrivacyPolicy = (path: string): PrivacyPolicyStore => {
    const file = openDocument(privacyShieldDocument, path, {
        fallback: (): PrivacyShieldPolicy => ({ ...DEFAULT_PRIVACY_SHIELD }),
        mode: 0o600,
        // Set aside, a file the owner wrote would be replaced by an off switch.
        onUnreadable: "refuse",
    });
    return {
        get: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new PrivacyPolicyUnreadableError(path, state.detail);
            }
            return state.value;
        },
        set: async (policy) => {
            await file.update(() => PrivacyShieldPolicySchema.parse(policy));
        },
    };
};
