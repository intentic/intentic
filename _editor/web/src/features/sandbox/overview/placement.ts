import type { IconName } from "@intentic/ui";
import type { SandboxSummary } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";

// WHERE THE CONTAINER ACTUALLY STANDS. Nothing else on a sandbox says it: the name, the logo and the status dot read
// identically for a laptop under the guest and a machine in someone else's datacentre, and the answer is what decides
// whether this repository's code ever leaves the owner's hardware. One mark carries the coarse answer everywhere a
// sandbox is drawn; the sentence carries whatever refinement the evidence supports.

export type SandboxPlacementKind = "cloud" | "device" | "own" | "shared";

// What a placement is read off. `hosted` and `owner` come from the platform row and are known the moment a sandbox
// is listed. `device` and `onThisComputer` arrive later (the daemon's fleet list, the loopback probe) and are absent
// far more often than they are false, so their absence narrows the answer to `own` rather than to "somewhere else".
export interface PlacementEvidence {
    // The platform's hosted-machine record. A record PRESENT is the one thing that means Intentic runs the machine,
    // so an absent one reads the same as an explicit null: this claim is only ever made on evidence that arrived.
    readonly hosted: { readonly region: string } | null | undefined;
    // False for a sandbox shared with this account: someone else's machine, wherever it stands.
    readonly owner: boolean;
    readonly daemonUrl?: string | null;
    // The owner's connected device reported to be running this container, when one is.
    readonly device?: string | undefined;
    // This browser reaches the daemon over loopback, which no address on another machine can answer.
    readonly onThisComputer?: boolean | undefined;
}

export interface SandboxPlacement {
    readonly kind: SandboxPlacementKind;
    readonly icon: IconName;
    // Two or three words, for a chip beside a name.
    readonly label: string;
    // The whole sentence, for a tooltip or a hub row. No trailing period: it joins other clauses.
    readonly detail: string;
}

// The hosted record if one arrived, folding null and absent together: both mean "nothing says Intentic runs this".
const hostedOf = (evidence: PlacementEvidence): { readonly region: string } | undefined => evidence.hosted ?? undefined;

// Location, not ownership: a colleague's HOSTED sandbox is in Intentic's cloud and says so, and the row's own
// "Shared" pill is what says whose it is. `shared` is therefore only for a machine somebody else runs themselves.
export const placementKind = (evidence: PlacementEvidence): SandboxPlacementKind => {
    if (hostedOf(evidence) !== undefined) {
        return `cloud`;
    }
    if (!evidence.owner) {
        return `shared`;
    }
    return evidence.device !== undefined || evidence.onThisComputer === true ? `device` : `own`;
};

// A glyph per kind, and deliberately only four: `desktop` is claimed for a machine that can be NAMED (a connected
// device, or loopback proving it is this very computer), so a rented server is never drawn as somebody's laptop.
const PLACEMENT_ICON: Readonly<Record<SandboxPlacementKind, IconName>> = {
    cloud: `cloud`,
    device: `desktop`,
    own: `server`,
    shared: `users`,
};

// The daemon's host, for the one case with no better name to give: `example.com` out of the tunnel URL.
const hostOf = (daemonUrl: string | null | undefined): string | undefined => {
    if (daemonUrl === null || daemonUrl === undefined || daemonUrl === ``) {
        return undefined;
    }
    try {
        return new URL(daemonUrl).hostname;
    } catch {
        return undefined;
    }
};

const worded = (evidence: PlacementEvidence, kind: SandboxPlacementKind): { label: string; detail: string } => {
    switch (kind) {
        case `cloud`: {
            // The region is a datacentre code (`arn`, `fra`); worth naming, and worth leaving out when it is empty
            // rather than printing a sentence that trails off into nothing.
            const region = hostedOf(evidence)?.region ?? ``;
            return {
                label: t(`sandbox.placement.cloudLabel`),
                detail: region === `` ? t(`sandbox.placement.cloudDetail`) : t(`sandbox.placement.cloudDetailRegion`, { region }),
            };
        }
        case `device`:
            // The device's own name when the fleet reports one; otherwise loopback answered, and "this computer" is
            // the stronger sentence anyway — it is the machine the reader is sitting at.
            return evidence.device === undefined
                ? { label: t(`sandbox.placement.thisComputerLabel`), detail: t(`sandbox.placement.thisComputerDetail`) }
                : { label: evidence.device, detail: t(`sandbox.placement.deviceDetail`, { device: evidence.device }) };
        case `own`: {
            const host = hostOf(evidence.daemonUrl);
            return {
                label: t(`sandbox.placement.ownLabel`),
                detail: host === undefined ? t(`sandbox.placement.ownDetail`) : t(`sandbox.placement.ownDetailHost`, { host }),
            };
        }
        case `shared`:
            return { label: t(`sandbox.placement.sharedLabel`), detail: t(`sandbox.placement.sharedDetail`) };
    }
};

export const sandboxPlacement = (evidence: PlacementEvidence): SandboxPlacement => {
    const kind = placementKind(evidence);
    return { kind, icon: PLACEMENT_ICON[kind], ...worded(evidence, kind) };
};

// The same answer straight off a platform row. Called bare for a row in a list, where only those fields are to hand;
// `refine` is for the ACTIVE sandbox alone, the only one the fleet and the transport can say anything more about.
export const placementOf = (
    sandbox: Pick<SandboxSummary, "hosted" | "role" | "daemonUrl">,
    refine: Pick<PlacementEvidence, "device" | "onThisComputer"> = {},
): SandboxPlacement =>
    sandboxPlacement({ hosted: sandbox.hosted, owner: sandbox.role === `owner`, daemonUrl: sandbox.daemonUrl, ...refine });

// The container's slug on its host machine, as the daemon's own address spells it. Best-effort by design: behind the
// owner's own Cloudflare zone the subdomain need not be the slug, and a slug that matches no device simply leaves the
// placement at `own` rather than naming the wrong machine.
export const slugFromDaemonUrl = (daemonUrl: string | null | undefined): string | undefined => {
    const host = hostOf(daemonUrl);
    const slug = host?.split(`.`)[0];
    return slug === undefined || slug === `` ? undefined : slug;
};
