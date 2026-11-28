import type {
    S2sMessageSend,
    S2sOutbox,
    S2sOutboxEntry,
    S2sTake,
    S2sThread,
    S2sThreadMessage,
    S2sThreadsList,
    S2sThreadSummary,
} from "@intentic/sandbox-contract/schemas/s2s";
import { refuse } from "@intentic/contract-serve";
import { DEMO_USER } from "../../platform";
import { DEMO_DAEMON_ORIGIN } from "../../transport";
import { holdBytes } from "../workspace/bytes";
import { contactOf, contactsList } from "./s2sContacts";

// This sandbox's inbox, as the daemon's threads keep it: a research sandbox's churn figures with their spreadsheets (the
// newest reply unread, a question of ours still waiting in the outbox because the research machine sleeps), the owner's
// logos sent over from their laptop, a problem report, and an invoice summary whose answer could not be delivered once
// the billing sandbox's key changed. Sending, reading, deleting and taking files write here.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHOP = new URL(DEMO_DAEMON_ORIGIN);

// A UUIDv7 for the moment given, as the envelope's id: the time in the first 48 bits, then random bits.
const envelopeId = (at: number): string => {
    const time = at.toString(16).padStart(12, `0`).slice(-12);
    const random = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => byte.toString(16).padStart(2, `0`)).join(``);
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${`89ab`[Number.parseInt(random[3] ?? `0`, 16) % 4]}${random.slice(4, 7)}-${random.slice(7, 19)}`;
};

// What each file is, for its download: a spreadsheet's rows, a logo's markup, or a few bytes standing in for a picture.
const FILES = new Map<string, { readonly type: string; readonly body: string }>([
    [`churn-october.csv`, { type: `text/csv`, body: `plan,customers,churned,rate\nstarter,1840,121,6.6%\npro,612,58,9.5%\nteam,204,6,2.9%\n` }],
    [`churn-by-tier.csv`, { type: `text/csv`, body: `tier,september,october,change\nstarter,6.1%,6.6%,+0.5\npro,5.8%,9.5%,+3.7\nteam,3.0%,2.9%,-0.1\n` }],
    [`cohorts.png`, { type: `image/png`, body: `PNG stand-in` }],
    [`logo.svg`, { type: `image/svg+xml`, body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#b9995f"/></svg>\n` }],
    [`logo-dark.svg`, { type: `image/svg+xml`, body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#2b2418"/></svg>\n` }],
    [`invoices-october.pdf`, { type: `application/pdf`, body: `%PDF-1.4 stand-in` }],
]);
const sizeOf = (name: string): number => new TextEncoder().encode(FILES.get(name)?.body ?? ``).length * 37;

interface Held {
    summary: Omit<S2sThreadSummary, `last` | `unread` | `messages` | `undelivered`>;
    messages: S2sThreadMessage[];
}

const message = (thread: string, contact: string, direction: `in` | `out`, ago: number, text: string, more: Partial<S2sThreadMessage> = {}): S2sThreadMessage => {
    const at = Date.now() - ago;
    const made: S2sThreadMessage = { id: envelopeId(at), thread, contact, direction, kind: `message`, text, attachments: [], sentAt: at, read: true, ...more };
    if (direction === `in`) {
        made.receivedAt = at + 1_500;
    } else if (made.delivery === undefined) {
        made.delivery = { state: `sent`, attempts: 1 };
    }
    return made;
};
const files = (...names: string[]) => names.map((name) => ({ name, size: sizeOf(name) }));

const seed = (): Held[] => [
    {
        summary: { id: `t-churn`, contact: `research`, contactName: `research-desk`, scope: { kind: `sandbox` }, subject: `October churn` },
        messages: [
            message(`t-churn`, `research`, `in`, 2 * DAY + 3 * HOUR, `Here is the churn breakdown you asked for. Starter is steady; Pro jumped, which I did not expect. Cohorts are in the picture.`, {
                attachments: files(`churn-october.csv`, `cohorts.png`),
            }),
            message(`t-churn`, `research`, `out`, 2 * DAY + HOUR, `Thanks. Can you split it by plan tier against September?`),
            message(`t-churn`, `research`, `in`, 52 * MINUTE, `Split by tier attached. Pro is the outlier: +3.7 points month on month, most of it in the second week.`, {
                attachments: files(`churn-by-tier.csv`),
                read: false,
            }),
            message(`t-churn`, `research`, `out`, 11 * MINUTE, `Could you also send the raw cancellation events for Pro, so we can line them up with the pricing change?`, {
                delivery: { state: `queued`, attempts: 3, reason: `research-desk is asleep: its machine did not answer` },
            }),
        ],
    },
    {
        summary: { id: `t-logos`, contact: `ada-laptop`, contactName: `ada-laptop`, scope: { kind: `person`, person: DEMO_USER.email } },
        messages: [
            message(`t-logos`, `ada-laptop`, `in`, 20 * HOUR, `The logo files from my laptop, light and dark. Use them for the new checkout header.`, {
                attachments: files(`logo.svg`, `logo-dark.svg`),
                as: DEMO_USER.email,
            }),
        ],
    },
    {
        summary: { id: `t-report`, contact: `research`, contactName: `research-desk`, scope: { kind: `sandbox` }, subject: `Checkout latency` },
        messages: [
            message(`t-report`, `research`, `in`, 3 * DAY, `p95 of POST /api/cart rose from 380 ms to 2.4 s after Tuesday's deploy; the slow part is the tax lookup.`, { kind: `report` }),
        ],
    },
    {
        summary: { id: `t-invoices`, contact: `billing`, contactName: `billing-partners`, scope: { kind: `sandbox` }, subject: `Invoices for October` },
        messages: [
            message(`t-invoices`, `billing`, `in`, 6 * DAY, `October's invoice summary is attached. Two refunds are still open on our side.`, { attachments: files(`invoices-october.pdf`) }),
            message(`t-invoices`, `billing`, `out`, 4 * DAY, `Got it. Which two? We show only one refund pending here.`, {
                delivery: { state: `undelivered`, attempts: 1, reason: `Its key changed with no proof; held until a person trusts the new key.` },
            }),
        ],
    },
];

const threads = new Map<string, Held>(seed().map((held) => [held.summary.id, held]));

const summaryOf = ({ summary, messages }: Held): S2sThreadSummary => {
    const last = messages.at(-1);
    return {
        ...summary,
        last: { at: last?.receivedAt ?? last?.sentAt ?? 0, direction: last?.direction ?? `in`, preview: (last?.text ?? ``).replace(/\s+/gu, ` `).slice(0, 200) },
        unread: messages.filter((each) => each.direction === `in` && !each.read).length,
        messages: messages.length,
        undelivered: messages.filter((each) => each.delivery?.state === `undelivered`).length,
    };
};

const heldOf = (id: string): Held => threads.get(id) ?? refuse(`No thread here is called ${id}.`, 404);

export const threadsList = (): S2sThreadsList => ({
    threads: [...threads.values()].map(summaryOf),
    requests: contactsList(SHOP).contacts.filter((each) => each.state === `pending-in`).length,
});

export const threadOf = (id: string): S2sThread => {
    const held = heldOf(id);
    return { thread: summaryOf(held), messages: held.messages.map((each) => ({ ...each })) };
};

export const markRead = (id: string) => {
    const held = heldOf(id);
    held.messages = held.messages.map((each) => ({ ...each, read: true }));
    return { ok: true as const };
};

export const deleteThread = (id: string) => {
    heldOf(id);
    threads.delete(id);
    return { ok: true as const };
};

const DELIVERED_AFTER_MS = 6_000;

// Filed in the outbox and answered at once; taken by the far side a few seconds later, as an awake contact would.
export const send = (input: S2sMessageSend) => {
    const contact = contactOf(SHOP, input.to);
    if (contact.state !== `accepted`) {
        return { state: `refused` as const, reason: `${contact.name} is not an accepted contact.` };
    }
    const thread = input.thread ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const fresh: Held = { summary: { id: thread, contact: contact.id, contactName: contact.name, scope: contact.scope }, messages: [] };
    if (input.subject !== undefined) {
        fresh.summary.subject = input.subject;
    }
    const held = threads.get(thread) ?? fresh;
    const made = message(thread, contact.id, `out`, 0, input.text, {
        attachments: input.files.map((file) => ({ name: file.name, size: Math.floor((file.data.length * 3) / 4) })),
        delivery: { state: `queued`, attempts: 0 },
    });
    held.messages.push(made);
    threads.set(thread, held);
    setTimeout(() => {
        held.messages = held.messages.map((each) => (each.id === made.id ? { ...each, delivery: { state: `sent`, attempts: 1 } } : each));
    }, DELIVERED_AFTER_MS);
    return { state: `queued` as const, id: made.id, thread };
};

const messageOf = (id: string): S2sThreadMessage =>
    [...threads.values()].flatMap((held) => held.messages).find((each) => each.id === id) ?? refuse(`No message here is called ${id}.`, 404);

export const fileOf = (id: string, name: string): Response => {
    const held = messageOf(id);
    if (!held.attachments.some((each) => each.name === name)) {
        refuse(`That message carries no file called ${name}.`, 404);
    }
    const file = FILES.get(name) ?? { type: `application/octet-stream`, body: `` };
    return new Response(file.body, { headers: { "content-type": file.type, "content-disposition": `attachment; filename="${name}"` } });
};

// Copied into the workspace's folder, never over a file already there.
export const take = (id: string, { dest, files: only }: S2sTake) => {
    const held = messageOf(id);
    const folder = dest.replace(/\/+$/u, ``);
    const taken = held.attachments.filter((each) => only === undefined || only.includes(each.name));
    for (const file of taken) {
        holdBytes(`${folder}/${file.name}`, new TextEncoder().encode(FILES.get(file.name)?.body ?? ``));
    }
    return { dest: folder, files: taken.map((each) => each.name) };
};

// What waits, read off the threads: every sent message not yet taken, and the ones that never will be.
export const outbox = (): S2sOutbox => ({
    entries: [...threads.values()].flatMap((held) =>
        held.messages
            .filter((each) => each.direction === `out` && (each.delivery?.state === `queued` || each.delivery?.state === `undelivered`))
            .map((each): S2sOutboxEntry => {
                const entry: S2sOutboxEntry = {
                    id: each.id,
                    contact: each.contact,
                    contactName: held.summary.contactName,
                    kind: each.kind,
                    thread: held.summary.id,
                    state: each.delivery?.state === `undelivered` ? `undelivered` : `waiting`,
                    attempts: each.delivery?.attempts ?? 0,
                    firstAt: each.sentAt,
                };
                if (entry.state === `waiting`) {
                    entry.nextAt = Date.now() + 4 * MINUTE;
                }
                if (each.delivery?.reason !== undefined) {
                    entry.lastError = each.delivery.reason;
                }
                return entry;
            }),
    ),
});
