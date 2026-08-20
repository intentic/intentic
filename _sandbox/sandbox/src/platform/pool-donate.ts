import type { Config } from "../env.config.js";
import { postToPlatform } from "./platform-client.js";

/* THE INSTALL DONATION, from the daemon's side, the one moment a non-service premium extension earns, and
 * the whole replacement for usage telemetry: nothing about what runs on this machine is ever reported, the
 * platform only sees the deliberate act of installing (or, at most monthly, updating) something worth paying
 * for. The platform owns the rules (membership, the credit spend, the monthly dedupe); what the daemon owes
 * the person installing is the outcome in their own terms: supported with N credits, already supported, or
 * refused and why. */

export interface DonationOutcome {
    // Whether the install may proceed, donated, or already supported this month.
    readonly ok: boolean;
    // Credits this call actually moved (0 on the already-supported path).
    readonly donated: number;
    // The refusal, in the user's terms, when ok is false.
    readonly detail?: string;
}

export const donateForExtension = async (config: Config, extensionId: string): Promise<DonationOutcome> => {
    if (config.platform.url === "" || config.connectToken === "") {
        return { ok: false, donated: 0, detail: "this sandbox is not connected to a platform, and premium extensions need one" };
    }
    let response;
    try {
        response = await postToPlatform(config, "/pool/donate", { extensionId });
    } catch {
        return { ok: false, donated: 0, detail: "the platform could not be reached to support the creator — nothing was charged" };
    }
    if (response.status === 200) {
        const donated = (response.json as { donated?: unknown } | undefined)?.donated;
        return { ok: true, donated: typeof donated === "number" ? donated : 0 };
    }
    // The platform's refusals are already written for the reader (membership_required, insufficient_credits);
    // relay the sentence when there is one rather than paraphrasing it.
    const message = (response.json as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof message === "string" && message !== "") {
        return { ok: false, donated: 0, detail: message };
    }
    if (response.status === 404) {
        return { ok: false, donated: 0, detail: "this platform offers no memberships" };
    }
    return { ok: false, donated: 0, detail: `the platform refused the donation (HTTP ${response.status})` };
};
