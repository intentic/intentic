import type { Config } from "../env.config.js";
import type { CliAnswer } from "../http/cli-answer.js";
import { callPlatform } from "../system/platform-relay.js";

// The owner's ACCOUNT as this sandbox can reach it: the three calls behind the `sandboxes` CLI, each authenticated by
// the provisioning token on the `fleet` capability rather than by this sandbox's own connect token. Buffered, because
// each is one question with one answer — the minutes-long half of a create is `ic` running on a device, not this.

/** Who the token belongs to, and whether it still verifies. The probe behind the capability's status row. */
export const fleetWhoami = (config: Config, token: string): Promise<CliAnswer> =>
    callPlatform(config, { method: "GET", path: "/fleet/whoami", auth: { kind: "bearer", token }, unreached: "nothing was created" });

/** Every sandbox on the account, as the platform knows them: name, address, whether it has ever announced. */
export const fleetList = (config: Config, token: string): Promise<CliAnswer> =>
    callPlatform(config, { method: "GET", path: "/fleet/sandboxes", auth: { kind: "bearer", token }, unreached: "nothing was created" });

export interface ProvisionAsk {
    readonly name: string;
    // A sandbox.toml the new box seeds itself from on first boot. Carries repos, capabilities by name and an overlay
    // the owner still has to approve there — never a credential, which is what makes it safe to send.
    readonly definition?: string;
}

/** Mints the row and the claim that creates one sandbox. The claim is spent by `ic` on a device, once, within minutes. */
export const fleetProvision = (config: Config, token: string, ask: ProvisionAsk): Promise<CliAnswer> =>
    callPlatform(config, {
        method: "POST",
        path: "/fleet/provision",
        payload: JSON.stringify(ask),
        auth: { kind: "bearer", token },
        unreached: "nothing was created",
    });

/* What the platform answers each of the three with, once the body parses. */

export interface FleetWho {
    readonly email: string;
    readonly label: string;
}

export interface FleetSandbox {
    readonly id: string;
    readonly name: string;
    readonly url: string | undefined;
    // Absent until the daemon in it first announces; a box that was created but never came up has none.
    readonly lastSeenAt: string | undefined;
}

export interface ProvisionedSandbox {
    readonly sandboxId: string;
    readonly name: string;
    readonly hostname: string;
    readonly setupCode: string;
    readonly expiresAt: string;
}

// The platform's refusals are already sentences written for a person, so they are read out rather than re-worded; a
// body that is not JSON at all is the one case this has to write its own line for.
export const answerError = (answer: { readonly status: number; readonly body: string }): string => {
    try {
        const parsed = JSON.parse(answer.body) as { error?: unknown; message?: unknown };
        const stated = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
        if (stated !== undefined && stated !== "") {
            return stated;
        }
    } catch {
        /* Not JSON: fall through to the raw text, which is what a proxy or a 502 page answers with. */
    }
    const raw = answer.body.trim();
    return raw === "" ? `the platform answered ${answer.status} with nothing to say` : raw.slice(0, 300);
};
