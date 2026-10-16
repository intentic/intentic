import type { Snapshot } from "@intentic/ext-e-urzad/snapshot";
import { STATE_DIR } from "@intentic/sandbox-contract";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { json } from "../../transport";

// Fictional offices in the full recording: no credentials and no requests to a government service.
export const officeCapabilities: CapabilitySummary[] = [
    { id: `office-ezd`, kind: `cli`, status: { state: `active` }, config: { provider: `ezd-rp`, apiUrl: `https://ezd.example.test`, webHost: `ezd.example.test` }, secrets: [`apiKey`] },
    { id: `office-ed`, kind: `cli`, status: { state: `active` }, config: { provider: `e-doreczenia`, environment: `https://int-ow.edoreczenia.gov.pl`, ade: `AE:PL-EXAMPLE-TEST`, systemName: `Demo office` }, secrets: [`certificate`, `privateKey`] },
];

const syncedAt = `2026-10-15T09:30:00.000Z`;
const snapshots = {
    "office-ezd": {
        card: `office-ezd`, service: `ezd-rp`, syncedAt,
        cases: [
            { id: `case-1`, sign: `KT.7240.12.2026`, title: `Organizacja komunikacji miejskiej`, status: `W toku`, jrwa: `7240`, deadline: `2026-10-22` },
            { id: `case-2`, sign: `KT.7240.13.2026`, title: `Wniosek o zmianę lokalizacji przystanku przy dworcu kolejowym`, status: `Do rozpatrzenia`, deadline: `2026-10-30` },
        ],
        tasks: [{ id: `task-1`, flowId: `flow-1`, received: syncedAt, status: `Do wykonania`, documentTitle: `Sprawdzenie rozkładu jazdy na okres zimowy`, caseSign: `KT.7240.12.2026` }],
        deliveries: [], proofs: [], actions: [],
    },
    "office-ed": {
        card: `office-ed`, service: `e-doreczenia`, syncedAt, cases: [], tasks: [],
        deliveries: [
            { id: `delivery-1`, subject: `Uzgodnienie rozkładu jazdy`, from: `Urząd Przykładowy`, status: `Waiting`, opened: false, kind: `Stub`, daysToReceive: 7 },
            { id: `delivery-2`, subject: `Potwierdzenie otrzymania dokumentacji przystanku`, from: `Zarząd Transportu Przykładowego`, status: `Received`, received: syncedAt, opened: true, kind: `Message`, saved: `${STATE_DIR}/records/e-urzad/office-ed/delivery-2` },
        ],
        proofs: [{ messageId: `delivery-2`, evidenceId: `proof-1`, type: `E.1`, eventDate: syncedAt, path: `${STATE_DIR}/records/e-urzad/office-ed/delivery-2/proofs/E.1.xml`, sha256: `0`.repeat(64), savedAt: syncedAt }],
        actions: [{ at: syncedAt, key: `e-urzad.open`, outcome: `Opened delivery-2; proof saved` }],
    },
} satisfies Record<string, Snapshot>;

export const officeResponse = (request: Request, url: URL): Response | undefined => {
    const match = /^\/x\/intentic\.e-urzad\/accounts\/([^/]+)\/(overview|sync|test)$/.exec(url.pathname);
    if (match === null) {
        return undefined;
    }
    const account = decodeURIComponent(match[1]!);
    if (account !== `office-ezd` && account !== `office-ed`) {
        return json({ error: `No such demo office` }, 404);
    }
    const snapshot = snapshots[account];
    if (match[2] === `overview` && request.method === `GET`) {
        return json({ snapshot });
    }
    if (request.method !== `POST`) {
        return json({ error: `Method not allowed` }, 405);
    }
    if (match[2] === `test`) {
        return json({ ok: true, detail: snapshot.service === `ezd-rp` ? { user: `Demo office` } : { mailbox: `AE:PL-EXAMPLE-TEST`, environment: `INT` } });
    }
    snapshot.syncedAt = new Date().toISOString();
    return json({ snapshot });
};
