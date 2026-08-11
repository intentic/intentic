import { z } from "zod";
import { type RegistryInstall, RegistryInstallSchema, resolveSource } from "./source.js";

/* THE EXTENSION REGISTRY: a git repo of pointers, and the two files in it.
 *
 * intentic hosts no extension code, builds none, and signs none. A registry is a repository whose
 * `.claude-plugin/marketplace.json` lists pointers to other people's repositories at a commit — so listing
 * costs a pull request, delisting deletes nothing, and anybody can run their own registry against a private
 * one. That file is Claude Code's plugin-marketplace format deliberately: `kind` and `trust` are intentic's
 * own fields and Claude Code ignores what it doesn't know, so one repo serves both consumers.
 *
 * The split into TWO files is the load-bearing part. `marketplace.json` is hand-edited and is the only place a
 * curated decision and source-bound admission are recorded; `registry.generated.json` is bot-written and holds
 * nothing but facts read back off the source host. Keeping star counts out of the curated file is what stops every nightly refresh from
 * being a merge conflict against an open pull request — and it keeps the review diff to the thing being
 * decided. A registry that carries no generated file is a registry with no stars, which renders fine. */

// Repo-relative, and the same two strings for the daemon (which clones), the scanner (which commits) and the
// site build (which fetches them raw).
export const REGISTRY_FILE = ".claude-plugin/marketplace.json";
export const REGISTRY_FACTS_FILE = ".claude-plugin/registry.generated.json";

// The default the Extensions tab browses and the gallery is built from. A default, not a gate: the browse
// field stays editable, so a company points it at an internal registry and never touches this one.
export const OFFICIAL_REGISTRY_URL = "https://github.com/intentic/registry";

// The GitHub topic an author adds to be found. This is discovery only — appearing in the scan gets you a pull
// request against the registry, never a listing.
export const REGISTRY_TOPIC = "intentic-extension";

/* THE ADMISSION RECORD for the official registry. Full results live in Trivy and intentic; this is the small,
 * durable fact a registry row needs in order to bind both verdicts to what an installer will actually clone.
 * Policies and scanner version are explicit because changing any admission control must make yesterday's
 * reviews visibly stale rather than silently pretending they ran under today's rules. Third-party registries
 * may carry other records; only this exact combination admits an entry to the official registry. */
export const OFFICIAL_SECURITY_REVIEW_POLICY = "intentic-extension-security-v1";
export const OFFICIAL_SECURITY_REVIEWER = "intentic-agent-gate";
export const OFFICIAL_DETERMINISTIC_SCAN_POLICY = "intentic-extension-deterministic-v1";
export const OFFICIAL_DETERMINISTIC_SCANNER = "trivy";
export const OFFICIAL_DETERMINISTIC_SCANNER_VERSION = "0.72.0";

const FULL_SHA = /^[0-9a-f]{40}$/;

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

/* WHAT A LISTING CLAIMS, and precisely what it doesn't.
 *
 * - `listed`   no HUMAN source review is claimed. In the official registry the separate securityReview must
 *              still show that both automated checks passed; third-party registries remain their own boundary.
 * - `verified` both automated checks passed and a human also read the source at that sha. Sorted first and badged.
 * - `blocked`  known-malicious or known-broken. It STAYS in the file with a reason rather than being deleted:
 *              removing the row hides it from people browsing and tells the people who already installed it
 *              nothing, which is backwards — they are the ones at risk.
 *
 * Absent on a third-party registry ⇒ `listed`, because a registry that doesn't use the field hasn't asserted
 * anything and shouldn't be read as if it had. */
export const RegistryTrustSchema = z.enum(["verified", "listed", "blocked"]);
export type RegistryTrust = z.infer<typeof RegistryTrustSchema>;

/* WHAT A LISTING COSTS. `free` is the default and the whole story for most rows. `premium` opts the listing
 * into the creator pool: installing it requires an intentic membership and donates a published number of the
 * member's credits to the publisher (once, deduped monthly — an update in a later month donates again), and
 * both surfaces badge it so the price is visible before the click. No usage is ever metered or reported for
 * this; the deliberate act of installing is the whole signal. On a third-party registry the field still
 * parses but means nothing — the pool only pays listings the platform's members actually install. */
export const RegistryTierSchema = z.enum(["free", "premium"]);
export type RegistryTier = z.infer<typeof RegistryTierSchema>;

const RegistryFileEntrySchema = z
    .object({
        name: z.string(),
        description: z.string().optional(),
        version: z.string().optional(),
        // "extension" installs as the sha-pinned `extension` capability; absent/"plugin" is a Claude Code plugin.
        kind: z.enum(["plugin", "extension"]).optional(),
        trust: RegistryTrustSchema.optional(),
        // Why it is blocked, or what was checked to verify it — shown verbatim wherever the badge is, because a
        // trust state with no stated reason is an opinion the reader can't weigh.
        trustReason: z.string().optional(),
        // Both automated checks' evidence, bound to the complete source identity below. It is deliberately
        // distinct from `trust: verified`: passing admission admits code; verified additionally says a human
        // read it. Keeping those claims apart stops automated verdicts being presented as human review.
        securityReview: RegistrySecurityReviewSchema.optional(),
        // This listing's pinned commit fixes a security problem in earlier commits — the fast lane: an installed
        // sandbox promotes its "update available" badge from ambient to attention-demanding, because there the OLD
        // version is the dangerous one. Asserted by the pull request like trust, and worth exactly that review.
        securityFix: z.boolean().optional(),
        tier: RegistryTierSchema.optional(),
        category: z.string().optional(),
        /* The mark the row is drawn with, copied off the extension's manifest by the scanner exactly like the
         * description and the version — the same two tiers the manifest declares (a simple-icons slug, then a name
         * from the app's icon set), and neither is required.
         *
         * It rides the CURATED file rather than the generated one, which looks wrong for a derived value until you
         * ask what a registry is for: a listing is what a human decided to publish, and the mark is part of how it
         * presents itself, so it belongs in the row a reviewer reads and can strike out. The generated file holds
         * only what a bot re-reads nightly and nobody reviews. It also has to be here to be of any use at all —
         * this is what the gallery and the in-app browse list render, and neither of them has the manifest: the
         * whole point of the row is that the code has NOT been cloned yet. */
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

/* Facts read off the source host, keyed by the curated entry's name. Deliberately NOT the upstream head sha:
 * the approved sha is the one that runs, updating is a pull request, and a file that advertised "there's a
 * newer commit over there" would be inviting a click that skips the review the whole model rests on. */
/* What the scan re-derived COLD at the listing's pinned sha — the same questions the daemon's readiness check
 * answers for an author before publishing, asked again by a stranger with nothing but the pointer. That
 * re-derivation is the whole value: an author's own checks describe the directory they ran them in, and these
 * describe what an installer actually gets. `sha` binds the answers to the commit they were read from, so a
 * listing repointed since the last scan renders no stale verdicts — the join drops checks whose sha no longer
 * matches rather than letting yesterday's answer describe today's pointer. */
const RegistryChecksSchema = z.object({
    sha: z.string(),
    // "ok", or the reason it is not, verbatim — a verdict with no stated reason is an opinion.
    manifest: z.string(),
    // "ok" / "none" (no UI bundle) / the reason the bundle cannot load where it is installed.
    bundle: z.string(),
    // The engines range the manifest declares at that sha. A raw fact rather than a verdict on purpose: the
    // scan does not know which app version any particular reader runs, but every consumer of this file does.
    engines: z.string().optional(),
});
export type RegistryChecks = z.infer<typeof RegistryChecksSchema>;

const RegistryFactsEntrySchema = z.object({
    name: z.string(),
    stars: z.number().int().nonnegative().optional(),
    // ISO-8601, last push to the source repo's default branch — the tiebreaker that does the real work while
    // every listing still has single-digit stars.
    pushedAt: z.string().optional(),
    checks: RegistryChecksSchema.optional(),
});

export const RegistryFactsSchema = z.object({
    scannedAt: z.string(),
    entries: z.array(RegistryFactsEntrySchema),
});
export type RegistryFacts = z.infer<typeof RegistryFactsSchema>;

// One row as every surface consumes it: the curated decision, the resolved pointer, and the upstream facts,
// already joined. This is also the daemon's browse wire shape — the app renders what the site renders.
export const RegistryEntrySchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    kind: z.enum(["plugin", "extension"]),
    trust: RegistryTrustSchema,
    trustReason: z.string().optional(),
    securityReview: RegistrySecurityReviewSchema.optional(),
    // False only for an executable row the official registry has not put through its current checks (and for a
    // blocked row). The row remains visible so a reader gets a reason instead of a mysteriously missing entry,
    // but every install/update surface refuses to act on it. Third-party registries remain their own trust
    // boundary and resolve their non-blocked rows as admitted without adopting intentic's policy.
    admitted: z.boolean(),
    securityFix: z.boolean().optional(),
    tier: RegistryTierSchema,
    category: z.string().optional(),
    // The mark, as the gallery and the app's browse list draw it — see the curated file's fields above.
    logo: z.string().optional(),
    icon: z.string().optional(),
    homepage: z.string().optional(),
    // Absent = a source the registry format can express but this daemon can't clone (npm, say). The row still
    // renders; the install button doesn't.
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

/* Join the curated file to the generated facts. `facts` is undefined for any registry that runs no scanner,
 * which is most of them — a private registry of six internal extensions wants the pointers and nothing else. */
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
            // Absent ⇒ free, so a registry that has never heard of the pool keeps meaning what it always did.
            tier: plugin.tier ?? "free",
            ...(plugin.description !== undefined ? { description: plugin.description } : {}),
            ...(plugin.version !== undefined ? { version: plugin.version } : {}),
            ...(plugin.trustReason !== undefined ? { trustReason: plugin.trustReason } : {}),
            ...(plugin.securityReview !== undefined ? { securityReview: plugin.securityReview } : {}),
            ...(plugin.securityFix !== undefined ? { securityFix: plugin.securityFix } : {}),
            ...(plugin.category !== undefined ? { category: plugin.category } : {}),
            ...(plugin.logo !== undefined ? { logo: plugin.logo } : {}),
            ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}),
            ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
            ...(install !== undefined ? { install } : {}),
            ...(upstream?.stars !== undefined ? { stars: upstream.stars } : {}),
            ...(upstream?.pushedAt !== undefined ? { pushedAt: upstream.pushedAt } : {}),
            // Only when derived from the sha this row still points at — a repointed listing renders no checks
            // until the next scan, which is the honest gap rather than yesterday's verdict on today's pointer.
            ...(upstream?.checks !== undefined && upstream.checks.sha === install?.ref ? { checks: upstream.checks } : {}),
        };
    });
};

/* THE ORDER, and why it isn't just stars.
 *
 * Stars are the obvious sort and the wrong one on day one: every listing will sit at nought to three of them
 * for months, so a pure star sort is a random order wearing a merit badge — and it is the single most
 * purchasable number on GitHub. So: the one field a human actually asserted leads, stars rank within that,
 * and recency breaks the ties that will be the overwhelmingly common case early on. Stars stay VISIBLE
 * either way; a reader can weigh them, they just don't get to be the whole ranking. */
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
