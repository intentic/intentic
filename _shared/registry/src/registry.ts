import { z } from "zod";
import { FULL_SHA, type RegistryInstall, RegistryInstallSchema, resolveSource } from "./source.js";

// A registry is a git repo of pointers: `marketplace.json` (Claude Code's plugin-marketplace format, plus intentic's
// own `kind`/`trust` fields) is hand-edited and curated; `registry.generated.json` is bot-written, holding only facts
// read off the source host, kept separate so a nightly refresh never conflicts with a review.

// Repo-relative; the same two strings the daemon clones, the scanner commits, and the site build fetches raw.
export const REGISTRY_FILE = ".claude-plugin/marketplace.json";
export const REGISTRY_FACTS_FILE = ".claude-plugin/registry.generated.json";

// Default the Extensions tab browses from; not a gate, the browse field stays editable to point elsewhere.
export const OFFICIAL_REGISTRY_URL = "https://github.com/intentic/registry";

// GitHub topic for discovery only; the scan turns it into a pull request against the registry, never a listing.
export const REGISTRY_TOPIC = "intentic-extension";

// Admission record for the official registry, binding both verdicts to what an installer actually clones. Bumping any
// policy or scanner version makes yesterday's reviews visibly stale, not silently valid under new rules.
export const OFFICIAL_SECURITY_REVIEW_POLICY = "intentic-extension-security-v1";
export const OFFICIAL_SECURITY_REVIEWER = "intentic-agent-gate";
export const OFFICIAL_DETERMINISTIC_SCAN_POLICY = "intentic-extension-deterministic-v1";
export const OFFICIAL_DETERMINISTIC_SCANNER = "trivy";
export const OFFICIAL_DETERMINISTIC_SCANNER_VERSION = "0.72.0";

export const RegistrySecurityReviewSchema = z.object({
    sha: z.string().regex(FULL_SHA, "must be a full lowercase commit sha"),
    url: z.string().min(1),
    path: z.string().min(1).optional(),
    policy: z.string().min(1),
    reviewer: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    runId: z.string().min(1),
    deterministic: z.object({
        policy: z.string().min(1),
        scanner: z.string().min(1),
        version: z.string().min(1),
        runId: z.string().min(1),
    }),
});
export type RegistrySecurityReview = z.infer<typeof RegistrySecurityReviewSchema>;

// What a listing claims:
// - listed: no human review asserted; the official registry still requires both automated checks to pass.
// - verified: both automated checks passed and a human read the source at that sha.
// - blocked: known-malicious or known-broken; stays in the file with a reason instead of being deleted.
// Absent on a third-party registry reads as listed.
export const RegistryTrustSchema = z.enum(["verified", "listed", "blocked"]);
export type RegistryTrust = z.infer<typeof RegistryTrustSchema>;

const RegistryFileEntrySchema = z
    .object({
        name: z.string(),
        description: z.string().optional(),
        version: z.string().optional(),
        // "extension" installs as the sha-pinned `extension` capability; absent/"plugin" is a Claude Code plugin.
        kind: z.enum(["plugin", "extension"]).optional(),
        trust: RegistryTrustSchema.optional(),
        // Why it is blocked, or what was checked to verify it; shown verbatim wherever the trust badge is.
        trustReason: z.string().optional(),
        // Both automated checks' evidence; distinct from `trust: verified`, which also claims a human read the code.
        securityReview: RegistrySecurityReviewSchema.optional(),
        // The pinned commit fixes a security issue in earlier ones; an installed sandbox's badge turns urgent.
        securityFix: z.boolean().optional(),
        category: z.string().optional(),
        // Copied off the manifest; kept as readable SVG text, not base64, so a reviewer can see it in the diff.
        art: z.string().max(4096).optional(),
        logo: z.string().optional(),
        icon: z.string().optional(),
        homepage: z.url().optional(),
        source: z.unknown(),
    })
    .superRefine((entry, ctx) => {
        const trust = entry.trust ?? "listed";
        if (trust === "blocked" && (entry.trustReason === undefined || entry.trustReason.trim() === "")) {
            ctx.addIssue({ code: "custom", path: ["trustReason"], message: "a blocked entry must say why" });
        }
        if (trust === "verified" && entry.securityReview === undefined) {
            ctx.addIssue({ code: "custom", path: ["securityReview"], message: "a verified entry must carry its security review" });
        }
        if (entry.securityReview === undefined) {
            return;
        }
        const install = resolveSource(entry.source, "", undefined);
        if (install?.ref !== entry.securityReview.sha || install?.url !== entry.securityReview.url || install.path !== entry.securityReview.path) {
            ctx.addIssue({
                code: "custom",
                path: ["securityReview"],
                message: "must equal the exact repository, commit and subdirectory named by source",
            });
        }
    });

export const RegistryFileSchema = z
    .object({
        name: z.string(),
        metadata: z.object({ pluginRoot: z.string().optional() }).optional(),
        plugins: z.array(RegistryFileEntrySchema),
    })
    .superRefine((file, ctx) => {
        const seen = new Set<string>();
        for (let at = 0; at < file.plugins.length; at += 1) {
            const name = file.plugins[at]?.name;
            if (name !== undefined && seen.has(name)) {
                ctx.addIssue({ code: "custom", path: ["plugins", at, "name"], message: "entry names must be unique" });
            }
            if (name !== undefined) {
                seen.add(name);
            }
        }
    });
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

// Facts read off the source host, keyed by the curated entry's name; deliberately not the upstream head sha,
// since updating is itself a pull request and this must not invite skipping that review.
// What the scan re-derives cold at the listing's pinned sha, the same readiness checks an author already ran,
// done again by a stranger. `sha` binds these answers to their commit, so a repointed listing shows no stale verdicts
// until the next scan.
const RegistryChecksSchema = z.object({
    sha: z.string(),
    // "ok", or the reason it is not, verbatim, a verdict with no stated reason is an opinion.
    manifest: z.string(),
    // "ok" / "none" (no UI bundle) / the reason the bundle cannot load where it is installed.
    bundle: z.string(),
    // Engines range the manifest declares at that sha; a raw fact, since the scan can't know a reader's app version.
    engines: z.string().optional(),
});
export type RegistryChecks = z.infer<typeof RegistryChecksSchema>;

const RegistryFactsEntrySchema = z.object({
    name: z.string(),
    stars: z.number().int().nonnegative().optional(),
    // ISO-8601 last push to the default branch; the tiebreaker that matters while stars stay single-digit.
    pushedAt: z.string().optional(),
    checks: RegistryChecksSchema.optional(),
});

export const RegistryFactsSchema = z.object({
    scannedAt: z.string(),
    entries: z.array(RegistryFactsEntrySchema),
});
export type RegistryFacts = z.infer<typeof RegistryFactsSchema>;

// One row as every surface consumes it: curated decision, resolved pointer and upstream facts, already joined.
// Also the daemon's browse wire shape; the app renders what the site renders.
export const RegistryEntrySchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    kind: z.enum(["plugin", "extension"]),
    trust: RegistryTrustSchema,
    trustReason: z.string().optional(),
    securityReview: RegistrySecurityReviewSchema.optional(),
    // False when blocked or not current-checked; the row stays visible but install/update won't act.
    admitted: z.boolean(),
    securityFix: z.boolean().optional(),
    category: z.string().optional(),
    // The mark, as the gallery and browse list draw it.
    art: z.string().optional(),
    logo: z.string().optional(),
    icon: z.string().optional(),
    homepage: z.string().optional(),
    // Absent = a source this daemon can't clone (npm, say); the row still renders, the install button doesn't.
    install: RegistryInstallSchema.optional(),
    stars: z.number().int().nonnegative().optional(),
    pushedAt: z.string().optional(),
    checks: RegistryChecksSchema.optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

const normalizedRegistryUrl = (value: string): string | undefined => {
    const scp = value.includes("://") ? null : /^(?:[^@]+@)?([^:]+):\/?(.+)$/u.exec(value);
    if (scp !== null) {
        return `${scp[1]?.toLowerCase()}/${scp[2]
            ?.replace(/\.git\/?$/u, "")
            .replace(/\/$/u, "")
            .toLowerCase()}`;
    }
    try {
        const url = new URL(value);
        const path = url.pathname
            .replace(/\.git\/?$/u, "")
            .replace(/\/$/u, "")
            .toLowerCase();
        return `${url.host.toLowerCase()}${path}`;
    } catch {
        return undefined;
    }
};

export const isOfficialRegistryUrl = (value: string): boolean => normalizedRegistryUrl(value) === normalizedRegistryUrl(OFFICIAL_REGISTRY_URL);

export const isCurrentSecurityReview = (review: RegistrySecurityReview | undefined, install: RegistryInstall | undefined): boolean =>
    review !== undefined &&
    review.sha === install?.ref &&
    review.url === install.url &&
    review.path === install.path &&
    review.policy === OFFICIAL_SECURITY_REVIEW_POLICY &&
    review.reviewer === OFFICIAL_SECURITY_REVIEWER &&
    review.deterministic.policy === OFFICIAL_DETERMINISTIC_SCAN_POLICY &&
    review.deterministic.scanner === OFFICIAL_DETERMINISTIC_SCANNER &&
    review.deterministic.version === OFFICIAL_DETERMINISTIC_SCANNER_VERSION;

// Joins the curated file to the generated facts; `facts` is undefined for a registry that runs no scanner (most private
// ones).
export const resolveRegistry = (file: RegistryFile, facts: RegistryFacts | undefined, registryUrl: string): RegistryEntry[] => {
    const byName = new Map(facts?.entries.map((entry) => [entry.name, entry]) ?? []);
    const official = isOfficialRegistryUrl(registryUrl);
    return file.plugins.map((plugin) => {
        const upstream = byName.get(plugin.name);
        const install: RegistryInstall | undefined = resolveSource(plugin.source, registryUrl, file.metadata?.pluginRoot);
        const kind = plugin.kind ?? "plugin";
        const trust = plugin.trust ?? "listed";
        const admitted = trust !== "blocked" && (kind !== "extension" || !official || isCurrentSecurityReview(plugin.securityReview, install));
        return {
            name: plugin.name,
            kind,
            trust,
            admitted,
            // Absent stays absent, preserving what an older registry file already meant.
            ...(plugin.description !== undefined ? { description: plugin.description } : {}),
            ...(plugin.version !== undefined ? { version: plugin.version } : {}),
            ...(plugin.trustReason !== undefined ? { trustReason: plugin.trustReason } : {}),
            ...(plugin.securityReview !== undefined ? { securityReview: plugin.securityReview } : {}),
            ...(plugin.securityFix !== undefined ? { securityFix: plugin.securityFix } : {}),
            ...(plugin.category !== undefined ? { category: plugin.category } : {}),
            ...(plugin.art !== undefined ? { art: plugin.art } : {}),
            ...(plugin.logo !== undefined ? { logo: plugin.logo } : {}),
            ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}),
            ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
            ...(install !== undefined ? { install } : {}),
            ...(upstream?.stars !== undefined ? { stars: upstream.stars } : {}),
            ...(upstream?.pushedAt !== undefined ? { pushedAt: upstream.pushedAt } : {}),
            // Only when derived from the sha this row still points at; a repoint shows no checks until the next scan.
            ...(upstream?.checks !== undefined && upstream.checks.sha === install?.ref ? { checks: upstream.checks } : {}),
        };
    });
};

// Sort order: verified trust leads (the one field a human actually asserted), stars rank within that, recency
// breaks ties. Stars are purchasable and start near zero for everyone, so they inform the order but don't define it.
export const compareEntries = (a: RegistryEntry, b: RegistryEntry): number => {
    if ((a.trust === "verified") !== (b.trust === "verified")) {
        return a.trust === "verified" ? -1 : 1;
    }
    if ((a.stars ?? 0) !== (b.stars ?? 0)) {
        return (b.stars ?? 0) - (a.stars ?? 0);
    }
    if ((a.pushedAt ?? "") !== (b.pushedAt ?? "")) {
        return (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
    }
    return a.name.localeCompare(b.name);
};
