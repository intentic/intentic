import { createHash } from "node:crypto";
import { WAKE_DOORS_MAX, type WakeDoor } from "@intentic/api-contract/ingress";
import type { PublicRouteContribution } from "@intentic/extension-manifest";
import { publicDoorPath } from "@intentic/sandbox-contract/extension-protocol";
import type { AutomationRecord } from "../../automations/automations-store.js";

/* THE WAKE DOORS A HOSTED MACHINE SLEEPS WITH (2026-11-27): the public paths a request may wake it at while it sleeps,
 * each with the SHA-256 of the secret such a request carries, saved with the alarm before every sleep
 * (hosted-sleep.ts) and matched by the platform when the edge asks about a request to a machine holding no tunnel
 * (api hosted-request-wake.ts). Only digests leave the machine.
 * - an enabled webhook automation: `/automations/<id>/fire`, its fire token (`?token=` or a bearer) the secret. A
 *   token never shown has no sender to hold it, so an automation with none has no door.
 * - an extension's public route declaring `wakes: true`, while an enabled automation listens on the provider that
 *   extension's listener owns (the one the path names, for an automation's route): `/door/<id>/<path>`, the wake secret
 *   minted for that path the secret (door-tokens.ts `wake`), the one `api.sleep.wakeUrl` hands out.
 * The list is rebuilt at every sleep, so a door goes with the automation that opened it; the composition root reads
 * the sources (bootstrap/platform-presence.ts `wakeDoorsFor`). */

export interface WakeDoorExtension {
    readonly id: string;
    // The provider its listener owns, when it owns one.
    readonly provider?: string | undefined;
    readonly routes: readonly Pick<PublicRouteContribution, "path" | "automation" | "wakes">[];
}

export interface WakeDoorSources {
    readonly automations: readonly Pick<AutomationRecord, "id" | "enabled" | "expiresAt" | "trigger">[];
    readonly extensions: readonly WakeDoorExtension[];
    // A webhook automation's fire token, never minted here.
    readonly fireToken: (automationId: string) => Promise<string | undefined>;
    // The wake secret of one door path, minted on first ask and the same ever after.
    readonly wakeSecret: (path: string) => Promise<string>;
    readonly now: number;
}

const sha256 = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** The public path of one `wakes` route, its `*` filled with the automation an automation's route is for. */
export const wakeRoutePath = (extension: string, route: string, automationId?: string): string =>
    publicDoorPath(extension, automationId === undefined ? route : route.replace("*", encodeURIComponent(automationId)));

type Live = WakeDoorSources["automations"][number];

const liveAt = (now: number) => (automation: Live): boolean => automation.enabled && (automation.expiresAt === undefined || automation.expiresAt > now);

// Every door path of one extension's `wakes` routes with an enabled automation behind it.
const extensionPaths = (extension: WakeDoorExtension, listening: readonly Live[]): string[] => {
    const provider = extension.provider;
    const heard = provider === undefined ? [] : listening.filter((automation) => automation.trigger.kind === "listener" && automation.trigger.provider === provider);
    if (heard.length === 0) {
        return [];
    }
    return extension.routes
        .filter((route) => route.wakes === true)
        .flatMap((route) =>
            route.automation === true ? heard.map((automation) => wakeRoutePath(extension.id, route.path, automation.id)) : [wakeRoutePath(extension.id, route.path)],
        );
};

/** The doors to sleep with, in a stable order, at most the contract's WAKE_DOORS_MAX. */
export const wakeDoorsOf = async (sources: WakeDoorSources): Promise<WakeDoor[]> => {
    const live = sources.automations.filter(liveAt(sources.now));
    const fired = await Promise.all(
        live
            .filter((automation) => automation.trigger.kind === "event")
            .map(async (automation): Promise<WakeDoor | undefined> => {
                const token = await sources.fireToken(automation.id);
                return token === undefined || token === "" ? undefined : { path: `/automations/${encodeURIComponent(automation.id)}/fire`, digest: sha256(token) };
            }),
    );
    const paths = [...new Set(sources.extensions.flatMap((extension) => extensionPaths(extension, live)))];
    const routed = await Promise.all(paths.map(async (path): Promise<WakeDoor> => ({ path, digest: sha256(await sources.wakeSecret(path)) })));
    return [...fired.filter((door) => door !== undefined), ...routed].toSorted((a, b) => a.path.localeCompare(b.path)).slice(0, WAKE_DOORS_MAX);
};
