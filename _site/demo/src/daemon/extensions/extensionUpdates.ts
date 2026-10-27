import { STATE_DIR } from "@intentic/constants";
import type { ExtensionSummary, ExtensionUpdate, ExtensionUpdatePolicy, PowersDiff } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { demoExtensions } from "./extensionList";
import { demoQuiet } from "../../mode";
import { pushWorkspaceChanged } from "../broadcast";
import { okAfter } from "../doors";

type ExtensionManifest = ExtensionSummary[`manifest`];
type Applied = SandboxHandlerOutput<`extensions`, `applyUpdate`>;

// The update lifecycle of the extensions installed from a repository, as the daemon keeps it: what the registry check
// last found (an offer, a version kept one step back, how the last update has behaved), the owner's standing policy, and
// the verbs around them. Every verb changes the row in place, so the next list says what happened.

const HOUR = 3_600_000;
const UPDATES_FILE = `${STATE_DIR}/records/extension-updates.json`;
const POLICY_FILE = `${STATE_DIR}/config/extension-update-policy.json`;
// How long the swap and the check take, so the held button and its progress line are seen rather than flashed.
const APPLY_MS = 2_600;
const REVERT_MS = 1_600;
const CHECK_MS = 1_800;
// An update is watched for a while before it counts as healthy, as the daemon's health check does.
const WATCH_MS = 25_000;

const DEFAULT_POLICY: ExtensionUpdatePolicy = { updates: `notify`, advisories: `auto-disable` };

// What an offer asks for that the running version does not: the new routes its UI calls. Kept beside the offer so the
// preview names them and the apply grants them.
interface Offer {
    readonly update: ExtensionUpdate;
    readonly addsRoutes: readonly string[];
}
const offers = new Map<string, Offer>();
// The manifest an apply replaced and the offer it took, so a revert puts both back.
const taken = new Map<string, { readonly manifest: ExtensionManifest; readonly offer: Offer }>();

let checkedAt = new Date(Date.now() - 3 * HOUR).toISOString();
export const updatesCheckedAt = (): string => checkedAt;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const bumped = (version: string): string => {
    const [major = `1`, minor = `0`] = version.split(`.`);
    return `${major}.${Number(minor) + 1}.0`;
};
const repoOf = (extension: ExtensionSummary): string => `https://github.com/${extension.manifest.publisher}/${extension.manifest.name}`;

const installed = (): ExtensionSummary[] => demoExtensions().filter((extension) => extension.source === `installed`);

// The recording's opening position, applied once: every repository install carries its policy; the loud recording also
// has one update on offer (asking for a route more) and one extension a week past an update that went well.
let seeded = false;
const seed = (): void => {
    if (seeded) {
        return;
    }
    seeded = true;
    const rows = installed();
    for (const extension of rows) {
        extension.updatePolicy = { ...DEFAULT_POLICY };
    }
    if (demoQuiet()) {
        return;
    }
    const offered = rows.find((extension) => extension.id === `storefront`) ?? rows[0];
    if (offered !== undefined) {
        const update: ExtensionUpdate = {
            ref: `4e9d1c07b2a6f835d0c1e74a9b62f0d3c8e517ab`,
            version: bumped(offered.manifest.version),
            url: repoOf(offered),
            trust: `listed`,
            registry: `intentic.dev`,
            at: new Date(Date.now() - 26 * HOUR).toISOString(),
            needsReview: `It asks to read the pipeline runs, which the installed version never did`,
        };
        offers.set(offered.id, { update, addsRoutes: [`GET /ci/runs`] });
        offered.update = update;
    }
    const watched = rows.find((extension) => extension.id === `intentic.knowledge`) ?? rows.find((extension) => extension !== offered);
    if (watched !== undefined) {
        const fromRef = `b71f03aa9e5c2d64f80b13e7a92c4d6f1e08b35c`;
        watched.previous = { ref: fromRef, version: `${watched.manifest.version.split(`.`)[0] ?? `1`}.0.0` };
        watched.health = { state: `healthy`, fromRef, at: new Date(Date.now() - 6 * 24 * HOUR).toISOString() };
    }
};

/** The installed rows with their update records joined in, as the list sends them. */
export const withUpdates = (): ExtensionSummary[] => {
    seed();
    return demoExtensions();
};

const findInstalled = (id: string): ExtensionSummary => {
    seed();
    const extension = demoExtensions().find((candidate) => candidate.id === id) ?? refuse(`no extension with that id is installed`, 404);
    return extension.source === `installed` ? extension : refuse(`only a git-installed extension has an update lifecycle`, 412);
};

// The powers a manifest declares, as the sentences the update dialog shows (the manifest's own `power` metadata, for the
// fields an update in this recording can move).
const powersOf = (manifest: ExtensionManifest): string[] => [
    ...(manifest.entry === undefined ? [] : [`runs a UI bundle in your browser`]),
    ...(manifest.server === undefined ? [] : [`runs a backend bundle inside the daemon's extension host`]),
    ...(manifest.permissions?.sandbox ?? []).map((route) => `its UI calls the sandbox route ${route}`),
    ...(manifest.contributes?.views ?? []).map((view) => `a ${view.surface} view "${view.label}"`),
    ...(manifest.contributes?.processes ?? []).map((process) => `a background process "${process.name}"`),
];

const grown = (manifest: ExtensionManifest, routes: readonly string[]): ExtensionManifest => ({
    ...manifest,
    permissions: { ...manifest.permissions, sandbox: [...(manifest.permissions?.sandbox ?? []), ...routes] },
});

const offerOf = (extension: ExtensionSummary): Offer =>
    offers.get(extension.id) ?? refuse(`${extension.id} is on the newest version the registry lists, nothing to update to`, 400);

export const previewUpdate = async (id: string): Promise<SandboxHandlerOutput<`extensions`, `updatePreview`>> => {
    const extension = findInstalled(id);
    const offer = offerOf(extension);
    await wait(CHECK_MS / 2);
    const before = powersOf(extension.manifest);
    const powers: PowersDiff = { added: offer.addsRoutes.map((route) => `its UI calls the sandbox route ${route}`), removed: [], unchanged: before };
    return {
        ref: offer.update.ref,
        version: offer.update.version ?? extension.manifest.version,
        installedVersion: extension.manifest.version,
        engines: extension.manifest.engines.intentic,
        compatible: true,
        powers,
    };
};

// The swap as one step: the outgoing version kept one back, the new one running and watched until it proves healthy.
export const applyUpdate = async (id: string, ref: string | undefined): Promise<Applied> => {
    const extension = findInstalled(id);
    const offer = offerOf(extension);
    if (ref !== undefined && ref !== offer.update.ref) {
        refuse(`${ref.slice(0, 12)} is not the version the registry offers for ${id}`, 400);
    }
    await wait(APPLY_MS);
    const fromRef = extension.commit;
    taken.set(id, { manifest: extension.manifest, offer });
    offers.delete(id);
    extension.previous = { ref: fromRef, version: extension.manifest.version };
    extension.manifest = { ...grown(extension.manifest, offer.addsRoutes), version: offer.update.version ?? extension.manifest.version };
    extension.commit = offer.update.ref;
    delete extension.update;
    extension.health = { state: `watching`, fromRef, at: new Date().toISOString() };
    pushWorkspaceChanged(UPDATES_FILE);
    setTimeout(() => {
        if (extension.health?.state === `watching` && extension.commit === offer.update.ref) {
            extension.health = { ...extension.health, state: `healthy` };
            pushWorkspaceChanged(UPDATES_FILE);
        }
    }, WATCH_MS);
    return { ok: true, ref: offer.update.ref };
};

// The kept copy back in place. The registry still lists what was reverted from, so it is on offer again.
export const revertUpdate = async (id: string): Promise<Applied> => {
    const extension = findInstalled(id);
    const previous = extension.previous ?? refuse(`no earlier version of ${id} is kept to go back to`, 400);
    await wait(REVERT_MS);
    const swapped = taken.get(id);
    extension.commit = previous.ref;
    extension.manifest = swapped?.manifest ?? { ...extension.manifest, version: previous.version ?? extension.manifest.version };
    delete extension.previous;
    delete extension.health;
    if (swapped !== undefined) {
        offers.set(id, swapped.offer);
        extension.update = swapped.offer.update;
        taken.delete(id);
    }
    pushWorkspaceChanged(UPDATES_FILE);
    return { ok: true, ref: previous.ref };
};

export const checkUpdates = async (): Promise<SandboxHandlerOutput<`extensions`, `checkUpdates`>> => {
    seed();
    await wait(CHECK_MS);
    checkedAt = new Date().toISOString();
    pushWorkspaceChanged(UPDATES_FILE);
    return { ok: true, checkedAt };
};

export const setUpdatePolicy = (id: string, patch: Partial<ExtensionUpdatePolicy>) => {
    const extension = findInstalled(id);
    return okAfter(() => {
        extension.updatePolicy = { ...DEFAULT_POLICY, ...extension.updatePolicy, ...patch };
        pushWorkspaceChanged(POLICY_FILE);
    });
};

/** What removing one forgets of its lifecycle, so a later list never names a version nothing holds. */
export const forgetUpdates = (id: string): void => {
    offers.delete(id);
    taken.delete(id);
};
