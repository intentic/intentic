import { grantNonce } from "@intentic/sandbox-contract/keyring-seal";
import { signAdminGrant } from "@intentic/sandbox-contract/policy/admin/admin-grant";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { Services } from "../../composition.js";
import { DEVICE_FEATURE_ADMIN_RUN, type DeviceFacts, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { whyOf } from "../../guard/card-offers.js";

/* RUN AS ADMINISTRATOR (2026-11-23). run_command's `admin` runs the command as the computer's administrator with no UAC
   prompt there (the machine's tools/admin/admin-run.ts, through intentic-remoted's Windows service). The owner says yes in
   chat instead, on the command gate's card (host-command-guard.ts), for every run: the card asks every time, so "allow
   everything in this conversation" never answers it, and only the conversation's auto-approve mark (or one it inherits
   from the conversation that started it) answers it by itself (roles/standing-answer.ts). It insists, so it reaches the
   owner's phone while they work elsewhere. It is asked even of a command the safety judge's tier 1 passes, since an
   ordinary-looking command is exactly what this card is about.

   Refused here, before any card, where no yes could make it run: an agent too old to know `admin` (it would drop the
   field and run the command unelevated), or the device's own switch off. */

export interface AdminAsk {
    // The agent's one line on what the command is for, shown on the card as its words.
    readonly why: string | undefined;
}

// What the safety log and the judge's slot say of an admin run in which the judge found no class to read.
export const ADMIN_SENTENCE = "It runs as this computer's administrator.";

const unsupported = (machine: string): string =>
    `Refused: the agent on "${machine}" cannot run commands as administrator: it is not on Windows, or older than administrator runs. ` +
    `It was not run. Ask the owner to update that device's agent; do not run it without admin or raise Windows' own prompt instead.`;

const switchedOff = (machine: string): string =>
    `Refused: "Run commands as administrator" is switched off for "${machine}", so it was not run. ` +
    `Ask the owner to turn it on (\`capabilities request ${machine} --set admin=on --why "…"\`), and say why; ` +
    `do not raise Windows' own prompt (Start-Process -Verb RunAs) instead, since nobody may be at that computer to answer it.`;

/**
 * Why an admin run cannot happen on `machine` whatever the owner answered, or undefined when it may be asked about.
 * Offline (no facts) is left to the bridge, which says so in its own words; a card that names no switch is the device's
 * own to refuse.
 */
export const adminBarred = async (
    machine: string,
    facts: Pick<DeviceFacts, "features"> | undefined,
    scopes: () => Promise<DeviceScopes | undefined>,
): Promise<string | undefined> => {
    if (facts !== undefined && !deviceSupports(facts, DEVICE_FEATURE_ADMIN_RUN)) {
        return unsupported(machine);
    }
    return (await scopes())?.admin === "off" ? switchedOff(machine) : undefined;
};

/** What an admin run's card says under its title when the judge had nothing to add: what a yes does, and the agent's reason. Pure. */
export const adminDescription = (admin: AdminAsk): string => {
    const why = whyOf(admin.why).why;
    return `It runs with administrator rights, with no Windows prompt at that computer.${why === undefined ? "" : ` The agent says: ${why}`}`;
};

/** What the agent reads while an admin run's card is still open. Pure. */
export const adminStillWaiting = (machine: string, later: string): string =>
    `Still waiting for the owner: a card asks them to approve running this as administrator on "${machine}", and it has not run yet. ` +
    `Their answer is kept for this exact command: make the same call again, with exactly the same command and admin: true, to wait for it. ${later} ` +
    `Do not run a different command, or raise Windows' own prompt, to do the same thing.`;

// A run_command call as it crosses to the machine, read loosely so every argument it carries goes on as it came.
export const RunCallSchema = z.looseObject({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]),
    method: z.literal("tools/call"),
    params: z.looseObject({ name: z.literal("run_command"), arguments: z.looseObject({ command: z.string() }) }),
});
export type RunCall = z.infer<typeof RunCallSchema>;

/**
 * The approved run_command call with the sandbox's grant for its command in `grant` (policy/admin/admin-grant.ts), replacing
 * any the agent wrote there: signed with this sandbox's keyring signing key, which the computer's service pinned when
 * it was set up, over the command exactly as the machine will run it.
 */
export const withAdminGrant = async (services: Pick<Services, "sandboxKeyringKeys">, call: RunCall): Promise<RpcMessage> => {
    const { sign } = await services.sandboxKeyringKeys.pairs();
    const grant = signAdminGrant(sign, call.params.arguments.command, grantNonce(), Date.now());
    return { ...call, params: { ...call.params, arguments: { ...call.params.arguments, grant: JSON.stringify(grant) } } };
};
