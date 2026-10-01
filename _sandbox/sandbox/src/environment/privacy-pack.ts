import { join } from "node:path";
import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { filePrivacyPolicy, privacyShieldDocument } from "../privacy/privacy-policy.js";
import { packFragment } from "./packs.js";

// The privacy pack (OCR and the name model) rides the overlay exactly when the shield's policy asks for one of its
// readers: on or watching, with images read to text or names found by the model. The shield works without it, so a
// sandbox that never turned those on never builds readers it would not run.
export const privacyPackWanted = (policy: PrivacyShieldPolicy): boolean =>
    policy.mode !== "off" && (policy.images === "read" || policy.names === "model");

// Read from the policy file, as the shield itself does. An unreadable policy composes without the pack rather than
// failing the whole overlay, which would also hold back every capability's fragment over one bad file.
export const privacyPackFragments = async (services: Pick<Services, "authRoot" | "logger">): Promise<string[]> => {
    const policy = await filePrivacyPolicy(join(services.authRoot, privacyShieldDocument.path))
        .get()
        .catch((error: unknown) => {
            services.logger.warn({ err: error }, "privacy policy unreadable while composing the environment: leaving its pack out");
            return undefined;
        });
    if (policy === undefined || !privacyPackWanted(policy)) {
        return [];
    }
    const fragment = await packFragment("privacy");
    return fragment === undefined ? [] : [fragment];
};
