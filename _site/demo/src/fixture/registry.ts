import type { Marketplace } from "@intentic-app/api-contract";

/* THE REGISTRY THE DEMO BROWSES, what the Sandbox screen's Discover row shows.
 *
 * The real thing is a git repository the daemon clones; there is no daemon here, so this stands in for the two
 * JSON files it would have read, already joined into the browse shape. Every row is a real published extension
 * except where a state needs one that does not exist yet.
 *
 * IT IS BUILT TO SHOW EVERY STATE, because that is what a demo of this surface is for. A catalogue where all
 * eight rows are green installable listings would hide the half of the design that matters: the honest default
 * ("nobody read this"), the row that is blocked and stays visible anyway, and the one that cannot be installed
 * in a click because its author never pinned a commit. A visitor should be able to see what this page says
 * when the news is bad. */

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

// Yesterday-ish, in the shape the scanner writes. Fixed strings rather than computed dates: the demo is built
// once and a "last pushed" that drifts with the visitor's clock is a fact nobody asserted.
const PUSHED = `2026-07-28T09:14:00.000Z`;

export const demoRegistry = (): Marketplace => ({
    name: `intentic registry`,
    plugins: [
        {
            name: `radarsu.paperwork`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `Read in full at this commit, it reads the folder it is pointed at and calls no route it does not declare.`,
            tier: `free`,
            description: `Invoices, receipts and statements: filed, renamed and searchable, without leaving the workspace.`,
            version: `1.2.0`,
            icon: `file-pdf`,
            install: { url: `https://github.com/radarsu/intentic-paperwork.git`, ref: sha(`253b3a1d96780987f604fca1ec2c25ab`) },
            securityReview: securityReview(`radarsu/intentic-paperwork`, sha(`253b3a1d96780987f604fca1ec2c25ab`)),
            stars: 34,
            pushedAt: PUSHED,
            checks: { sha: sha(`253b3a1d96780987f604fca1ec2c25ab`), manifest: `ok`, bundle: `none` },
        },
        {
            name: `radarsu.everyday-viewers`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `Read in full at this commit, viewers only, no daemon routes declared at all.`,
            tier: `free`,
            description: `The file types the app can't show yet: calendars, spreadsheets, GPS traces, subtitles and fonts.`,
            version: `1.0.3`,
            icon: `image`,
            install: { url: `https://github.com/radarsu/intentic-everyday-viewers.git`, ref: sha(`1539580a3fc05dcdb12fcd67cff75754`) },
            securityReview: securityReview(`radarsu/intentic-everyday-viewers`, sha(`1539580a3fc05dcdb12fcd67cff75754`)),
            stars: 21,
            pushedAt: PUSHED,
            checks: { sha: sha(`1539580a3fc05dcdb12fcd67cff75754`), manifest: `ok`, bundle: `ok` },
        },
        {
            name: `radarsu.homelab`,
            kind: `extension`,
            trust: `listed`,
            admitted: true,
            tier: `free`,
            description: `Four CLI cards and their skills for a home server: Proxmox, TrueNAS, Home Assistant and Unifi.`,
            version: `0.4.1`,
            icon: `server`,
            install: { url: `https://github.com/radarsu/intentic-homelab.git`, ref: sha(`d3bd54b69fc4fefd379f33305049c277`) },
            securityReview: securityReview(`radarsu/intentic-homelab`, sha(`d3bd54b69fc4fefd379f33305049c277`)),
            stars: 12,
            pushedAt: PUSHED,
            checks: { sha: sha(`d3bd54b69fc4fefd379f33305049c277`), manifest: `ok`, bundle: `none` },
        },
        {
            name: `radarsu.contact-sheet`,
            kind: `extension`,
            trust: `listed`,
            admitted: true,
            tier: `free`,
            description: `A folder of photographs as one contact sheet you can flip through, with the shot data under each frame.`,
            version: `0.2.0`,
            icon: `image`,
            install: { url: `https://github.com/radarsu/intentic-contact-sheet.git`, ref: sha(`5b17f40bca49dd2a29c88ccf32b7215d`) },
            securityReview: securityReview(`radarsu/intentic-contact-sheet`, sha(`5b17f40bca49dd2a29c88ccf32b7215d`)),
            stars: 7,
            pushedAt: PUSHED,
            checks: { sha: sha(`5b17f40bca49dd2a29c88ccf32b7215d`), manifest: `ok`, bundle: `ok` },
        },
        // Premium, the creator-pool listing, badged before the click on both surfaces.
        {
            name: `northbound.oncall`,
            kind: `extension`,
            trust: `listed`,
            admitted: true,
            tier: `premium`,
            description: `Who is on call, what is paging them, and the last five incidents, from PagerDuty and Opsgenie together.`,
            version: `2.1.0`,
            icon: `wave-pulse`,
            install: { url: `https://github.com/northbound/intentic-oncall.git`, ref: sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`) },
            securityReview: securityReview(`northbound/intentic-oncall`, sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`)),
            stars: 58,
            pushedAt: PUSHED,
            checks: { sha: sha(`77aa10ce4b2f9d0e6c8b13f5a4d92e07`), manifest: `ok`, bundle: `ok` },
        },
        // Already here: the demo sandbox runs the knowledge extension, so this row reads "installed" rather than
        // offering to add a second copy of something the visitor already has.
        {
            name: `intentic.knowledge`,
            kind: `extension`,
            trust: `verified`,
            admitted: true,
            trustReason: `First-party, and read at this commit like any other listing.`,
            tier: `free`,
            description: `The owner's knowledge base: markdown notes that are also a typed graph of people, projects and decisions.`,
            version: `1.4.0`,
            icon: `book`,
            install: { url: `https://github.com/intentic/intentic.git`, ref: sha(`b41c9e75d208af36e5107cb92da4f8e3`), path: `_extensions/knowledge` },
            securityReview: securityReview(`intentic/intentic`, sha(`b41c9e75d208af36e5107cb92da4f8e3`), `_extensions/knowledge`),
            stars: 96,
            pushedAt: PUSHED,
            checks: { sha: sha(`b41c9e75d208af36e5107cb92da4f8e3`), manifest: `ok`, bundle: `ok` },
        },
        /* A listing whose author never pinned a commit. It reads, it links out, and it cannot be installed in a
         * click, which is the pressure that makes authors pin, and is worth a visitor seeing stated. */
        {
            name: `hollowpeak.timesheets`,
            kind: `extension`,
            trust: `listed`,
            admitted: false,
            tier: `free`,
            description: `Turns the week's commits and terminal sessions into a timesheet you can argue with before you file it.`,
            version: `0.1.0`,
            icon: `clock`,
            install: { url: `https://github.com/hollowpeak/intentic-timesheets.git`, ref: `main` },
            stars: 3,
            pushedAt: PUSHED,
        },
        /* Blocked, and STILL LISTED. Deleting the row would hide it from people browsing and tell the people who
         * already installed it nothing, which is backwards, they are the ones at risk. */
        {
            name: `driftwood.autocommit`,
            kind: `extension`,
            trust: `blocked`,
            admitted: false,
            trustReason: `Ships a background process that pushes to any remote it finds, including ones it was never pointed at.`,
            tier: `free`,
            description: `Commits and pushes your work automatically, on a timer.`,
            version: `3.0.1`,
            icon: `cloud-upload`,
            install: { url: `https://github.com/driftwood/intentic-autocommit.git`, ref: sha(`c0ffee1234567890abcdef0123456789`) },
            stars: 141,
            pushedAt: PUSHED,
        },
    ],
});
