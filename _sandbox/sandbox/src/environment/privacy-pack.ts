import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import type { Services } from "../composition.js";
import { packFragment } from "../image/packs.js";

// The privacy pack (the PaddleOCR text reader and the name model) rides the overlay exactly when the shield's policy
// asks for one of its readers: on or watching, with images masked or names found by the model. The shield turned off,
// or sending images as they are with the dictionary alone, never builds readers it would not run.
export const privacyPackWanted = (policy: PrivacyShieldPolicy): boolean =>
    policy.mode !== "off" && (policy.images === "mask" || policy.names === "model");

// Read through the shield itself, so it is the policy the shield acts on: the owner's file with a bound sandbox's
// organisation pins applied (compliance/org-pins.ts), never a file edited looser that would leave out the readers a
// pinned shield needs. An unreadable policy composes without the pack rather than failing the whole overlay, which
// would also hold back every capability's fragment over one bad file.
export const privacyPackFragments = async (services: Pick<Services, "privacyShield" | "logger">): Promise<string[]> => {
    const policy = await services.privacyShield.policy().catch((error: unknown) => {
        services.logger.warn({ err: error }, "privacy policy unreadable while composing the environment: leaving its pack out");
        return undefined;
    });
    if (policy === undefined || !privacyPackWanted(policy)) {
        return [];
    }
    const fragment = await packFragment("privacy");
    return fragment === undefined ? [] : [fragment];
};
