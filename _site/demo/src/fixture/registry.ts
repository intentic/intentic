import type { Marketplace } from "@intentic/api-contract";

// Registry for the Sandbox screen's Discover row: stands in for the two JSON files a real daemon would clone and read.
// Built to show every state the surface distinguishes (installed, blocked but still listed, unpinnable), not an
// all-green catalogue.

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);
const securityReview = (repo: string, commit: string, path?: string) => ({
    sha: commit,
    url: `https://github.com/${repo}.git`,
    ...(path !== undefined ? { path } : {}),
    policy: `intentic-extension-security-v1`,
    reviewer: `intentic-agent-gate`,
    reviewedAt: `2026-07-28T09:14:00.000Z`,
    runId: `demo-security-review`,
    deterministic: {
        policy: `intentic-extension-deterministic-v1`,
        scanner: `trivy`,
        version: `0.72.0`,
        runId: `demo-deterministic-scan`,
    },
});

// Fixed timestamp, not computed: a 'last pushed' shouldn't drift with the visitor's clock.
const PUSHED = `2026-07-28T09:14:00.000Z`;

export const demoRegistry = (): Marketplace => ({
    name: `intentic registry`,
    plugins: [
        {
            name: `intentic.saldeo`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `Read in full at this commit; backend calls only the two daemon routes it declares.`,
            description: `SaldeoSMART invoices, documents and bank statements — reconciled in the workspace, with an agent that knows the API.`,
            version: `1.0.0`,
            icon: `credit-card`,
            install: { url: `https://github.com/radarsu/intentic-saldeo.git`, ref: sha(`709a31c87d49e50896f43a766f62e29b90283dab`) },
            securityReview: securityReview(`radarsu/intentic-saldeo`, sha(`709a31c87d49e50896f43a766f62e29b90283dab`)),
            stars: 34,
            pushedAt: PUSHED,
            checks: { sha: sha(`709a31c87d49e50896f43a766f62e29b90283dab`), manifest: `ok`, bundle: `ok` },
        },
        {
            name: `intentic.logs`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `Read in full at this commit; one read-only view, no routes beyond what the manifest allows.`,
            description: `The sandbox's debug log surface — terminal captures, intentic run logs and the daemon log under /history/logs.`,
            version: `1.0.0`,
            icon: `file`,
            install: { url: `https://github.com/intentic/extension-logs.git`, ref: sha(`d87b891ebc2cba5fcfbd15a5e7a7f5cfc3f80bb5`) },
            securityReview: securityReview(`intentic/extension-logs`, sha(`d87b891ebc2cba5fcfbd15a5e7a7f5cfc3f80bb5`)),
            stars: 21,
            pushedAt: PUSHED,
            checks: { sha: sha(`d87b891ebc2cba5fcfbd15a5e7a7f5cfc3f80bb5`), manifest: `ok`, bundle: `ok` },
        },
        {
            name: `intentic.scrub`,
            kind: `extension`,
            trust: `listed`,
            admitted: true,
            description: `Strip provenance metadata from images and documents before they leave the workspace — C2PA, EXIF, generator tags, document properties.`,
            version: `1.0.0`,
            icon: `eraser`,
            install: { url: `https://github.com/intentic/intentic.git`, ref: sha(`b41c9e75d208af36e5107cb92da4f8e3`), path: `extensions/scrub` },
            securityReview: securityReview(`intentic/intentic`, sha(`b41c9e75d208af36e5107cb92da4f8e3`), `extensions/scrub`),
            stars: 12,
            pushedAt: PUSHED,
            checks: { sha: sha(`b41c9e75d208af36e5107cb92da4f8e3`), manifest: `ok`, bundle: `none` },
        },
        // Premium creator-pool listing, badged before the click on both surfaces.
        {
            name: `northbound.oncall`,
            kind: `extension`,
            trust: `listed`,
            admitted: true,
            description: `Who is on call, what is paging them, and the last five incidents, from PagerDuty and Opsgenie together.`,
            version: `2.1.0`,
            icon: `wave-pulse`,
            install: { url: `https://github.com/northbound/intentic-oncall.git`, ref: sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`) },
            securityReview: securityReview(`northbound/intentic-oncall`, sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`)),
            stars: 58,
            pushedAt: PUSHED,
            checks: { sha: sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`), manifest: `ok`, bundle: `ok` },
        },
        // Demo sandbox already runs this extension, so the row reads installed, not offered again.
        {
            name: `intentic.knowledge`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `First-party, and read at this commit like any other listing.`,
            description: `The owner's knowledge base: markdown notes that are also a typed graph of people, projects and decisions.`,
            version: `1.4.0`,
            icon: `book`,
            install: { url: `https://github.com/intentic/intentic.git`, ref: sha(`b41c9e75d208af36e5107cb92da4f8e3`), path: `_extensions/knowledge` },
            securityReview: securityReview(`intentic/intentic`, sha(`b41c9e75d208af36e5107cb92da4f8e3`), `_extensions/knowledge`),
            stars: 96,
            pushedAt: PUSHED,
            checks: { sha: sha(`b41c9e75d208af36e5107cb92da4f8e3`), manifest: `ok`, bundle: `ok` },
        },
        // Pinned but never audited: installs only after the owner acknowledges that nobody checked the code.
        {
            name: `tidewater.standup`,
            kind: `extension`,
            trust: `listed`,
            admitted: false,
            description: `Yesterday, today, blockers: drafted from the week's merged branches and agent runs, posted where your team reads.`,
            version: `0.4.2`,
            icon: `calendar`,
            install: { url: `https://github.com/tidewater/intentic-standup.git`, ref: sha(`5e1f0a93d7c2b684`) },
            stars: 7,
            pushedAt: PUSHED,
        },
        // Author never pinned a commit: it reads and links out but can't install in one click.
        {
            name: `hollowpeak.timesheets`,
            kind: `extension`,
            trust: `listed`,
            admitted: false,
            description: `Turns the week's commits and terminal sessions into a timesheet you can argue with before you file it.`,
            version: `0.1.0`,
            icon: `clock`,
            install: { url: `https://github.com/hollowpeak/intentic-timesheets.git`, ref: `main` },
            stars: 3,
            pushedAt: PUSHED,
        },
        // Blocked but still listed: removing it would hide the warning from people who already installed it.
        {
            name: `driftwood.autocommit`,
            kind: `extension`,
            trust: `blocked`,
            admitted: false,
            trustReason: `Ships a background process that pushes to any remote it finds, including ones it was never pointed at.`,
            description: `Commits and pushes your work automatically, on a timer.`,
            version: `3.0.1`,
            icon: `cloud-upload`,
            install: { url: `https://github.com/driftwood/intentic-autocommit.git`, ref: sha(`c0ffee1234567890abcdef0123456789`) },
            stars: 141,
            pushedAt: PUSHED,
        },
    ],
});
