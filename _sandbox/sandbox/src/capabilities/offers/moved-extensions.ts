import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import type { Capability, CapabilityRecommendation } from "@intentic/sandbox-contract/schemas/capabilities";
import { extensionCacheDir, extensionStateDir, STATE_GROUP_DIR } from "@intentic/sandbox-contract/state/workspace-state";
import { readExtensionEnablement } from "../extension-inventory/extension-enablement.js";
import { statePath } from "../../state-paths.js";
import type { DismissedRecommendation } from "./dismissals-store.js";

// FIRST-PARTY EXTENSIONS THAT LEFT THE IMAGE (2026-11-23). e-urzad and prawo were baked into every sandbox image
// (/opt/extensions/<name>) and e-urzad's view was compiled into the editor; they now ship from their own repositories,
// like knowledge and maintenance. A sandbox that used one would lose it silently on its next image, so the Extension
// tile recommends installing it from its repository at the commit pinned below: the ordinary git install, where the
// owner reads and approves its powers like any other. Nothing here installs anything.
//
// (2026-11-26) The same for a feature that left the daemon for an extension a sandbox may never have installed: the bug
// intake, whose reports, inbox and wakes are the issues extension's backend now. A sandbox whose intake was core takes no
// report until that extension is on, so it is offered once the sandbox shows it used the intake (its inbox, or an
// automation on the intake's `issues` source).
//
// It is re-derived from what the sandbox holds on every read (recommend.ts), so it is said once: it stops the moment the
// install lands (a capability of kind `extension` at that repository) or the owner declines it, and comes back only if
// the evidence it named changes. Only one is offered at a time, since the dismissal store keeps one row per catalog
// entry and both are offered on the same `extension` tile: a declined row names one offer's evidence, and every offer
// up to and including that one counts as declined, so declining the second never brings the first back.

export interface MovedExtension {
    // The manifest's publisher.name, as its switch and settings are keyed.
    readonly id: string;
    // The manifest's name: the directory its records, state and cache were kept under.
    readonly name: string;
    // What the owner calls it.
    readonly label: string;
    readonly url: string;
    // The commit the owner is offered, in full: an extension install pins exactly the code that runs.
    readonly ref: string;
    // The connectors it contributed, by catalog id: a cli capability whose `provider` is one of these was its card.
    readonly connectors: readonly string[];
    // Where it kept a cache before extensions had their own (storage-catalog.ts DAEMON_CACHES), workspace-relative.
    readonly legacyCache?: string;
    // The listener provider its automations name, when a stored automation on it is a sign of use.
    readonly listenerProvider?: string;
    // What the offer says moved, when it is not the extension itself.
    readonly reason?: string;
}

// The standalone repositories, at the commits that first shipped them on their own (their manifests' `entry` and bundled
// `dist/` replace what the image and the editor used to carry). Bump a ref only to a commit someone has reviewed.
export const MOVED_EXTENSIONS: readonly MovedExtension[] = [
    {
        id: "intentic.e-urzad",
        name: "e-urzad",
        label: "e-Urząd",
        url: "https://github.com/intentic/extension-e-urzad",
        ref: "8ed58cf0cfa230e4301382007866e10101d66fa9",
        connectors: ["ezd-rp", "e-doreczenia"],
    },
    {
        id: "intentic.prawo",
        name: "prawo",
        label: "Prawo",
        url: "https://github.com/intentic/extension-prawo",
        ref: "1e9f396537324a2f61a0a8738471882b481fb1cc",
        connectors: ["prawo"],
        legacyCache: `${STATE_GROUP_DIR.local}/cache/prawo`,
    },
    // The commit the registry listed when the intake moved: bump it to the one that ships the extension's backend (its
    // src/server) in the same sitting as the registry listing, since an older commit has the views and no intake.
    {
        id: "intentic.issues",
        name: "issues",
        label: "Issues",
        url: "https://github.com/intentic/extension-issues",
        ref: "155f62ff146ab76e59ad9ba5cea309cd24405ebe",
        connectors: [],
        listenerProvider: "issues",
        reason: "Bug reports moved from the sandbox into the Issues extension",
    },
];

const sameRepository = (a: string, b: string): boolean => {
    const bare = (url: string): string =>
        url
            .trim()
            .toLowerCase()
            .replace(/\/+$/, "")
            .replace(/\.git$/, "");
    return bare(a) === bare(b);
};

const installedFrom = (active: readonly Capability[], moved: MovedExtension): boolean =>
    active.some((capability) => capability.kind === "extension" && sameRepository(capability.config.url, moved.url));

// Absent is unused; any other failure to list is the daemon's to hear about, not a "no".
const hasEntries = async (dir: string): Promise<boolean> => {
    try {
        return (await readdir(dir)).length > 0;
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        throw error;
    }
};

// The first sign that this sandbox used it, printed so the claim can be checked: one of its cards, something it wrote,
// or the owner's own switch or settings for it. A switch that was never touched says nothing: absent means on, for every
// baked extension alike.
const evidenceOf = async (
    root: string,
    active: readonly Capability[],
    moved: MovedExtension,
    enablement: Readonly<Record<string, boolean>>,
    // Whose settings the owner saved, by id.
    settings: ReadonlySet<string>,
): Promise<string | undefined> => {
    for (const capability of active) {
        if (capability.kind === "cli" && moved.connectors.includes(capability.config.provider)) {
            return `capability ${capability.id} (${capability.config.provider})`;
        }
    }
    const dirs = [
        `${STATE_GROUP_DIR.records}/${moved.name}`,
        extensionStateDir(moved.id),
        extensionCacheDir(moved.id),
        ...(moved.legacyCache === undefined ? [] : [moved.legacyCache]),
    ];
    for (const dir of dirs) {
        if (await hasEntries(join(root, dir))) {
            return `${dir}/`;
        }
    }
    if (moved.listenerProvider !== undefined && (await listensOn(root, moved.listenerProvider))) {
        return `an automation on the ${moved.listenerProvider} source in automations.json`;
    }
    if (enablement[moved.id] === true) {
        return `${moved.id} switched on in extension-enablement.json`;
    }
    if (settings.has(moved.id)) {
        return `${moved.id} settings in extension-settings.json`;
    }
    return undefined;
};

// Each stored automation's trigger, as far as telling its source apart needs: anything else in the file is kept loose.
const StoredTriggersSchema = z.array(z.object({ trigger: z.object({ kind: z.string(), provider: z.string().optional() }).loose() }).loose());

// Whether a stored automation listens on `provider`, read off the file itself: the automations store sits in the
// automations area, which capabilities may not import. A file that does not parse is no evidence either way.
const listensOn = async (root: string, provider: string): Promise<boolean> => {
    let text: string;
    try {
        text = await readFile(statePath(root, ".intentic/config/automations.json"), "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return false;
        }
        throw error;
    }
    const stored = StoredTriggersSchema.safeParse(parseJsonOr(text, undefined));
    return stored.success && stored.data.some(({ trigger }) => trigger.kind === "listener" && trigger.provider === provider);
};

// Only which extensions have saved settings, read off the file itself: its store (extensions/extension-settings.ts) sits
// behind the vault and in the extensions area, which capabilities may not import.
const settingsKeys = async (root: string): Promise<ReadonlySet<string>> => {
    let text: string;
    try {
        text = await readFile(statePath(root, ".intentic/config/extension-settings.json"), "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return new Set();
        }
        throw error;
    }
    const parsed: unknown = JSON.parse(text);
    return new Set(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : []);
};

/** The one moved extension to offer now, as an Extension-tile recommendation prefilled with its repository and commit. */
export const movedExtensionRecommendations = async (
    root: string,
    active: readonly Capability[],
    dismissed: readonly DismissedRecommendation[],
): Promise<CapabilityRecommendation[]> => {
    const waiting = MOVED_EXTENSIONS.filter((moved) => !installedFrom(active, moved));
    if (waiting.length === 0) {
        return [];
    }
    const [enablement, settings] = await Promise.all([readExtensionEnablement(root), settingsKeys(root)]);
    const offers: CapabilityRecommendation[] = [];
    for (const moved of waiting) {
        const evidence = await evidenceOf(root, active, moved, enablement, settings);
        if (evidence !== undefined) {
            offers.push({
                entry: "extension",
                evidence,
                reason: moved.reason ?? `${moved.label} moved to its own repository`,
                prefill: { url: moved.url, ref: moved.ref },
            });
        }
    }
    const declined = dismissed.find((row) => row.entry === "extension");
    const through = declined === undefined ? -1 : offers.findIndex((offer) => offer.evidence === declined.evidence);
    return offers.slice(through + 1, through + 2);
};
