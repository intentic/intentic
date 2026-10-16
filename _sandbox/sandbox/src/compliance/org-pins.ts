import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import { type OrgPolicy, orgPinnedGroups } from "@intentic/sandbox-contract/schemas/organisation";
import { orgPinRefusal, type OrgPinRefusal } from "@intentic/sandbox-contract/policy/org-locks";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { Logger } from "pino";
import type { AuditService } from "../audit/audit-service.js";
import type { OrgPolicyHolder } from "../org/org-policy.js";
import { privacyShieldDocument } from "../privacy/privacy-policy.js";
import { settingsDocument } from "../settings/settings-store.js";
import { applyPreset, presetItemsOfGroups } from "./preset.js";

/* AN ORGANISATION'S PINNED SETTINGS (docs/architecture/organisations.md, "Pins"). A policy's `preset` names groups of
 * the public-office preset (compliance/preset.ts); every item in them is applied to what the daemon READS from
 * settings.json and the privacy shield's policy, whatever the files hold. So an agent or a person who edits the file
 * directly (`.intentic/config/settings.json` is the workspace's, and the auth root is reachable to an agent running as
 * root) changes nothing the daemon acts on, and the next read finds the difference, records it and writes the pinned
 * value back (`reapply`), so a program that reads the file itself (an extension's CLI) sees it too once converged.
 *
 * Applying a preset item never loosens and is idempotent (preset.ts), which is what makes reading through it safe: a
 * sandbox already stricter than a pin keeps its own value, and pinning twice is pinning once. A write that would undo a
 * pin is refused by the route that takes it (`settingsPinRefusal`, `privacyPinRefusal`); one from anywhere else
 * (a sandbox.toml definition, a program) is stored with the pins applied. A personal sandbox has no policy, and every
 * function here hands back what it was given. */

export interface PinOutcome<T> {
    // What the daemon acts on.
    readonly value: T;
    // The preset items the stored value held looser than the pins; empty when it already complied.
    readonly loosened: readonly string[];
    // The same pins over another value: what converging the file writes, read-modify-write under the file's queue.
    readonly reapply: (current: T) => T;
}

// The read side a store is handed: it pins what it read, and says what it found loosened.
export type Pin<T> = (stored: T) => Promise<PinOutcome<T>>;

export type PinnedDocument = "settings" | "privacy";

// Pure: the settings with the policy's pinned preset items applied.
export const pinSettings = (settings: SandboxSettings, policy: OrgPolicy | undefined): PinOutcome<SandboxSettings> => {
    const ids = presetItemsOfGroups(orgPinnedGroups(policy)).settings;
    const reapply = (current: SandboxSettings): SandboxSettings =>
        ids.length === 0 ? current : applyPreset({ settings: current, privacy: DEFAULT_PRIVACY_SHIELD, nameModel: false }, ids, true).settings;
    if (ids.length === 0) {
        return { value: settings, loosened: [], reapply };
    }
    const outcome = applyPreset({ settings, privacy: DEFAULT_PRIVACY_SHIELD, nameModel: false }, ids, true);
    return { value: outcome.settings, loosened: outcome.applied, reapply };
};

// Pure: the privacy shield's policy with the policy's pinned privacy items applied. `nameModel` says whether a local name
// model is installed; without one, finding names by the model is no promise the shield could keep, and is skipped.
export const pinPrivacy = (privacy: PrivacyShieldPolicy, policy: OrgPolicy | undefined, nameModel: boolean): PinOutcome<PrivacyShieldPolicy> => {
    const ids = presetItemsOfGroups(orgPinnedGroups(policy)).privacy;
    const apply = (current: PrivacyShieldPolicy) => applyPreset({ settings: PLACEHOLDER_SETTINGS, privacy: current, nameModel }, ids, true);
    const reapply = (current: PrivacyShieldPolicy): PrivacyShieldPolicy => (ids.length === 0 ? current : apply(current).privacy);
    if (ids.length === 0) {
        return { value: privacy, loosened: [], reapply };
    }
    const outcome = apply(privacy);
    return { value: outcome.privacy, loosened: outcome.applied, reapply };
};

// The privacy items read and write only the privacy half of the preset's state; the settings half is a default nobody
// reads back.
const PLACEHOLDER_SETTINGS: SandboxSettings = SandboxSettingsSchema.parse({});

// Says once what a pinned read found, and again only when that changes: reads come every turn and every request, the
// audit trail wants the moment a file was loosened, not each time it is read.
export const createPinDriftReporter = (deps: {
    readonly logger: Logger;
    readonly record: (event: { readonly document: PinnedDocument; readonly items: readonly string[]; readonly org: string }) => void;
}): ((document: PinnedDocument, policy: OrgPolicy | undefined, loosened: readonly string[]) => void) => {
    const last = new Map<PinnedDocument, string>();
    return (document, policy, loosened) => {
        const signature = loosened.join(",");
        if (last.get(document) === signature) {
            return;
        }
        last.set(document, signature);
        if (policy === undefined || loosened.length === 0) {
            return;
        }
        deps.logger.warn({ document, items: loosened, org: policy.orgId }, "org pins: the stored value was looser than the organisation allows; holding the pinned value");
        deps.record({ document, items: loosened, org: policy.orgName });
    };
};

export const settingsPin =
    (holder: Pick<OrgPolicyHolder, "current">, drifted: (document: PinnedDocument, policy: OrgPolicy | undefined, loosened: readonly string[]) => void): Pin<SandboxSettings> =>
    async (stored) => {
        const policy = await holder.current();
        const pinned = pinSettings(stored, policy);
        drifted("settings", policy, pinned.loosened);
        return pinned;
    };

export const privacyPin =
    (
        holder: Pick<OrgPolicyHolder, "current">,
        nameModel: () => Promise<boolean>,
        drifted: (document: PinnedDocument, policy: OrgPolicy | undefined, loosened: readonly string[]) => void,
    ): Pin<PrivacyShieldPolicy> =>
    async (stored) => {
        const policy = await holder.current();
        if (orgPinnedGroups(policy).length === 0) {
            return { value: stored, loosened: [], reapply: (current) => current };
        }
        const pinned = pinPrivacy(stored, policy, await nameModel());
        drifted("privacy", policy, pinned.loosened);
        return pinned;
    };

// The refusal for a write that would undo a pin, or undefined to take it. Only the routes a person saves through ask:
// they answer 403 with the items named, where a silent rewrite would leave the page showing a value that did not stick.
export const settingsPinRefusal = async (holder: Pick<OrgPolicyHolder, "current">, next: SandboxSettings): Promise<OrgPinRefusal | undefined> => {
    const policy = await holder.current();
    const loosened = pinSettings(next, policy).loosened;
    return policy === undefined || loosened.length === 0 ? undefined : orgPinRefusal(policy, loosened);
};

export const privacyPinRefusal = async (
    holder: Pick<OrgPolicyHolder, "current">,
    next: PrivacyShieldPolicy,
    nameModel: () => Promise<boolean>,
): Promise<OrgPinRefusal | undefined> => {
    const policy = await holder.current();
    if (policy === undefined || orgPinnedGroups(policy).length === 0) {
        return undefined;
    }
    const loosened = pinPrivacy(next, policy, await nameModel()).loosened;
    return loosened.length === 0 ? undefined : orgPinRefusal(policy, loosened);
};

// The pins as composition.ts hands them to the settings store and the privacy shield, with what a pinned read finds
// looser going to the audit trail. Built before the audit service exists, so it reaches it through `whole` per call.
export interface OrgPins {
    readonly settingsPin: Pin<SandboxSettings>;
    readonly privacyPin: (nameModel: () => Promise<boolean>) => Pin<PrivacyShieldPolicy>;
    readonly warn: (message: string, error: Error) => void;
}

export const createOrgPins = (deps: {
    readonly holder: Pick<OrgPolicyHolder, "current">;
    readonly logger: Logger;
    readonly whole: () => { readonly audit: Pick<AuditService, "record"> };
}): OrgPins => {
    const drifted = createPinDriftReporter({
        logger: deps.logger,
        record: (drift) =>
            deps.whole().audit.record({
                actor: { kind: "system", reason: "organisation pins" },
                action: "org.pins.held",
                target: drift.document === "settings" ? settingsDocument.path : privacyShieldDocument.path,
                details: { items: [...drift.items], org: drift.org },
            }),
    });
    return {
        settingsPin: settingsPin(deps.holder, drifted),
        privacyPin: (nameModel) => privacyPin(deps.holder, nameModel, drifted),
        warn: (message, error) => deps.logger.warn({ err: error }, message),
    };
};
