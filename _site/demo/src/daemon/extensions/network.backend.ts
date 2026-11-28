import type { RawContext } from "@intentic/contract-serve";
import { json } from "../../transport";

// The Network extension's backend namespace (its src/server/routes.ts): acme-shop reads a few feeds, a Nostr key and two
// other sandboxes' signed logs, one of which was caught rewriting its history, and has published two posts of its own,
// one approved with a passkey. Adding a source, refreshing or publishing answers as the backend would.
const NETWORK = `/x/intentic.network`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = (): number => Date.now();
const iso = (ago: number): string => new Date(now() - ago).toISOString();

const record = (type: string, headline: string, text: string, via: string, author: string, ago: number, url: string | null = null) => ({
    "@context": `https://schema.org`,
    "@type": type,
    headline,
    text,
    url,
    datePublished: iso(ago),
    author: { "@type": `Person`, name: author },
    sdPublisher: { "@type": `SoftwareApplication`, name: `intentic.network/${via}` },
    isBasedOn: [via],
    keywords: [],
    image: [],
});

interface DemoItem {
    readonly id: string;
    readonly sourceId: string;
    readonly verification: string;
    readonly verifiedBy?: string;
    readonly score: number | null;
    readonly summary: string | null;
    readonly labels: readonly string[];
    readonly record: ReturnType<typeof record>;
    readonly ago: number;
}

const item = (rest: DemoItem) => ({
    id: rest.id,
    sourceId: rest.sourceId,
    nativeId: rest.id,
    record: rest.record,
    verification: rest.verification,
    verifiedBy: rest.verifiedBy,
    fetchedAt: now() - rest.ago,
    publishedAt: now() - rest.ago,
    score: rest.score,
    summary: rest.summary,
    labels: rest.labels,
    curatedAt: rest.score === null ? null : now() - 10 * MINUTE,
});

const source = (id: string, kind: string, address: string, label: string, polledAgo: number, lastError: string | null = null) => ({
    id,
    kind,
    address,
    label,
    schemaType: `Article`,
    enabled: true,
    createdAt: now() - 30 * 24 * HOUR,
    lastPollAt: now() - polledAgo,
    nextPollAt: now() + 20 * MINUTE,
    failures: lastError === null ? 0 : 2,
    lastError,
    etag: null,
    lastModified: null,
});

let sources = [
    source(`s-energy`, `rss`, `https://energy-weekly.example/feed.xml`, `Energy Weekly`, 8 * MINUTE),
    source(`s-lab`, `intentic`, `lab.acme-research.example`, `Acme Research lab`, 6 * MINUTE),
    source(`s-nostr`, `nostr`, `7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e`, `fiatjaf`, 12 * MINUTE),
    source(`s-mirror`, `intentic`, `sandbox-k3v9.sbx.example`, `Grid watch`, 40 * MINUTE),
    source(`s-blog`, `rss`, `https://old-blog.example/rss`, `Old blog`, 2 * HOUR, `Source returned HTTP 404`),
];

const items = () => [
    item({
        id: `i1`,
        sourceId: `s-lab`,
        verification: `signature-valid`,
        verifiedBy: `intentic-log`,
        score: 92,
        summary: `The lab's grid-storage pilot reached 41 MWh; it publishes the raw measurements with each weekly entry.`,
        labels: [`energy`, `storage`],
        record: record(`Article`, `Grid storage pilot: week 12 measurements`, `Raw measurements attached.`, `intentic.network`, `Acme Research`, 2 * HOUR),
        ago: 2 * HOUR,
    }),
    item({
        id: `i2`,
        sourceId: `s-energy`,
        verification: `unsigned`,
        score: 78,
        summary: `A summary of this week's capacity auctions in Poland and Germany.`,
        labels: [`energy`, `markets`],
        record: record(`Article`, `Capacity auctions, week 48`, `This week's auctions…`, `rss`, `Energy Weekly`, 5 * HOUR, `https://energy-weekly.example/48`),
        ago: 5 * HOUR,
    }),
    item({
        id: `i3`,
        sourceId: `s-nostr`,
        verification: `signature-valid`,
        verifiedBy: `nostr-schnorr`,
        score: 40,
        summary: `A short note on relay discovery.`,
        labels: [`nostr`],
        record: record(`SocialMediaPosting`, `relays that gossip are relays that survive`, `relays that gossip are relays that survive`, `nostr`, `7e7e9c42…`, 7 * HOUR),
        ago: 7 * HOUR,
    }),
    item({
        id: `i4`,
        sourceId: `s-energy`,
        verification: `unsigned`,
        score: null,
        summary: null,
        labels: [],
        record: record(`Article`, `Letters: on heat pumps in old buildings`, `Readers write in about…`, `rss`, `Energy Weekly`, 9 * HOUR, `https://energy-weekly.example/letters`),
        ago: 9 * HOUR,
    }),
];

const peers = () => [
    {
        sourceId: `s-lab`,
        address: `lab.acme-research.example`,
        name: `Acme Research lab`,
        fingerprint: `isk1:3k2vqz7m5n4c8d6f2h9j3k5l7m9n2p4q6r8s2t4v6w8x2y4z6a8b`,
        state: `ok`,
        problem: null,
        domainVerified: true,
        passkeyShare: 0.8,
        vouches: [{ issuer: `Polish Energy Cooperative`, trusted: true, claims: { kind: `organisation`, verifiedBy: `document`, country: `PL` } }],
        level: 3,
        declared: 12,
        verified: 12,
        witnessed: 2,
        witnesses: 2,
        hasEvidence: false,
        syncedAt: now() - 6 * MINUTE,
    },
    {
        sourceId: `s-mirror`,
        address: `sandbox-k3v9.sbx.example`,
        name: `Grid watch`,
        fingerprint: `isk1:7a2b4c6d8e2f4g6h8j2k4l6m8n2p4q6r8s2t4v6w8x2y4z6a8b2c4d`,
        state: `equivocation`,
        problem: `its entries do not hash to the root it signed: its history was rewritten`,
        domainVerified: false,
        passkeyShare: 0,
        vouches: [],
        level: 0,
        declared: 31,
        verified: 27,
        witnessed: 0,
        witnesses: 2,
        hasEvidence: true,
        syncedAt: now() - 40 * MINUTE,
    },
];

let waiting: { id: string; kind: string; headline: string; createdAt: number; cosign: string }[] = [];

const publishing = () => ({
    size: 2,
    catalogUrl: `https://acme-shop.sbx.example/door/intentic.network/catalog`,
    published: [
        { seq: 1, type: `SocialMediaPosting`, headline: `Our storage spec is open: read it and tell us what breaks`, publishedAt: iso(26 * HOUR), tombstoneOf: null, withdrawn: false, cosigned: true },
        { seq: 0, type: `Article`, headline: `Why acme-shop publishes its supplier audits`, publishedAt: iso(9 * 24 * HOUR), tombstoneOf: null, withdrawn: false, cosigned: false },
    ],
    waiting,
});

const settings = {
    curationRules: `Prefer measurements and primary sources about energy storage and grid markets. Drop opinion without data.`,
    pollMinutes: 30,
    retentionDays: 30,
    maxItems: 10000,
    nostrRelays: `wss://relay.damus.io\nwss://nos.lol`,
    autoCurate: false,
    curateBatches: 4,
    requirePasskey: false,
    authorName: ``,
    catalogKeywords: `energy, storage`,
    catalogLanguages: `en, pl`,
    witnesses: `witness.coop.example\nsandbox-w2.sbx.example`,
    guides: `guide.coop.example`,
    trustedIssuers: ``,
    witnessMode: false,
    mirrorMode: false,
    guideMode: false,
};

const snapshot = () => ({ sources, items: items(), settings, canWrite: true, uncurated: 1, publishing: publishing(), peers: peers() });

export const networkBackend = {
    [`GET ${NETWORK}/snapshot`]: () => json(snapshot()),
    [`POST ${NETWORK}/refresh`]: () => json(snapshot()),
    [`POST ${NETWORK}/curate`]: () => json({ conversationId: `network-curate-demo` }),
    [`POST ${NETWORK}/sources`]: async (context: RawContext) => {
        // SAFETY: the demo's own view sends this body; every field is optional and read with a fallback.
        const body = (await context.request.json()) as { kind?: string; address?: string; label?: string };
        sources = [...sources, source(`s-${sources.length + 1}`, body.kind ?? `rss`, body.address ?? ``, body.label || (body.address ?? ``), 0)];
        return json(snapshot());
    },
    [`POST ${NETWORK}/publish`]: async (context: RawContext) => {
        // SAFETY: the demo's own view sends this body; every field is optional and read with a fallback.
        const body = (await context.request.json()) as { text?: string; headline?: string };
        const id = `network-demo-${waiting.length + 1}`;
        waiting = [...waiting, { id, kind: `publish`, headline: body.headline || (body.text ?? ``).slice(0, 160), createdAt: now(), cosign: `offered` }];
        return json({ approval: id });
    },
    [`GET ${NETWORK}/discover`]: () =>
        json({ hits: [{ address: `heat.coop.example`, name: `Heat cooperative`, types: [`Article`], keywords: [`energy`, `heat pumps`], languages: [`pl`], via: `guide.coop.example` }] }),
} satisfies Readonly<Record<string, (context: RawContext) => Response | Promise<Response>>>;
