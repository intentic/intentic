import {
    type InboundLinkMint,
    type InboundLinkMinted,
    type InboundLinksList,
    type InboundLinkSummary,
    type InboundLinkTermsUpdate,
    type LinkRequestDecision,
    LinkTermsSchema,
} from "@intentic/sandbox-contract/schemas/links";
import { refuse } from "@intentic/contract-serve";
import { DEMO_USER } from "../../platform";
import { LENDING_SANDBOX, lendingSandboxShown } from "../../world/sandboxRegistry";
import { demoPersonas } from "../extensions/personas";
import { sayOrBook } from "../board/queue";

// Other sandboxes linked into this one (the Access tab's Linked sandboxes, Sandbox ▸ Map), held as the daemon's link
// store holds them: minted with a token shown once, re-termed, revoked, and the tasks a link's terms hold for the owner
// allowed (the task opens its conversation here and starts) or declined. The support desk's sandbox hands this one tasks
// as Maya, one of them waiting for the owner's yes; where the account lists Ada's laptop (accounts.ts), the laptop
// borrows this sandbox's Claude Max over an accounts link, which takes no tasks.
//
// Each sandbox of the demo's world keeps its own links, told apart by the address a call was sent to: the laptop's are
// the ones this sandbox's Models page mints and widens when it brings the laptop's accounts in.

const shopLinks = (): InboundLinkSummary[] => [
    {
        id: `lnk_support`,
        label: `support-desk`,
        from: { sandboxId: `sbx_support`, url: `https://support-desk.acme.dev` },
        terms: { actsAs: `maya-support`, approve: true, turnsPerHour: 20, tasks: true, accounts: [] },
        createdAt: Date.now() - 20 * 24 * 3_600_000,
        createdBy: DEMO_USER.email,
        lastUsedAt: Date.now() - 2 * 3_600_000,
        conversations: 4,
        requests: [{ id: `req_1`, conversationId: `link-refund-macro`, task: `Draft the refund macro for damaged parcels`, askedAt: Date.now() - 40 * 60_000 }],
    },
    ...(lendingSandboxShown
        ? [
              {
                  id: `lnk_laptop_accounts`,
                  label: LENDING_SANDBOX.name,
                  from: { sandboxId: LENDING_SANDBOX.id, url: LENDING_SANDBOX.origin },
                  terms: { approve: false, turnsPerHour: 20, tasks: false, accounts: [{ provider: `claude`, account: `acc_claude_demo` }] },
                  createdAt: Date.now() - 6 * 24 * 3_600_000,
                  createdBy: DEMO_USER.email,
                  lastUsedAt: Date.now() - 25 * 60_000,
                  conversations: 0,
                  requests: [],
              },
          ]
        : []),
];

// The links each sandbox holds, by its daemon's address; anything but the laptop is this sandbox.
const books = new Map<string, InboundLinkSummary[]>();
const bookAt = (at: URL): string => (at.origin === LENDING_SANDBOX.origin ? LENDING_SANDBOX.origin : `shop`);
const linksAt = (at: URL): InboundLinkSummary[] => {
    const key = bookAt(at);
    const held = books.get(key) ?? (key === `shop` ? shopLinks() : []);
    books.set(key, held);
    return held;
};
const write = (at: URL, next: InboundLinkSummary[]): void => {
    books.set(bookAt(at), next);
};

export const linksList = (at: URL): InboundLinksList => ({ links: [...linksAt(at)] });

const linkOf = (at: URL, id: string): InboundLinkSummary => linksAt(at).find((link) => link.id === id) ?? refuse(`no such link`, 404);

// As the daemon refuses a persona the sandbox does not hold, rather than minting a link that could never run.
const checkPersona = (actsAs: string | null | undefined): void => {
    if (actsAs !== null && actsAs !== undefined && !demoPersonas.some((persona) => persona.id === actsAs)) {
        refuse(`No persona here is called ${actsAs}.`, 400);
    }
};

export const mintLink = (at: URL, { label, from, terms }: InboundLinkMint): InboundLinkMinted => {
    checkPersona(terms?.actsAs);
    const id = `lnk_${crypto.randomUUID().slice(0, 8)}`;
    const summary: InboundLinkSummary = { id, label, terms: LinkTermsSchema.parse(terms ?? {}), createdAt: Date.now(), createdBy: DEMO_USER.email, conversations: 0, requests: [] };
    if (from !== undefined) {
        summary.from = from;
    }
    write(at, [...linksAt(at), summary]);
    return { id, token: `ilk_${crypto.randomUUID().replaceAll(`-`, ``)}` };
};

// Whole fields replaced, the rest kept; `null` takes the persona or the service off.
export const updateLink = (at: URL, id: string, { label, actsAs, runAs, approve, turnsPerHour, tasks, accounts }: InboundLinkTermsUpdate): InboundLinkSummary => {
    checkPersona(actsAs);
    const link = linkOf(at, id);
    const terms: InboundLinkSummary[`terms`] = {
        approve: approve ?? link.terms.approve,
        turnsPerHour: turnsPerHour ?? link.terms.turnsPerHour,
        tasks: tasks ?? link.terms.tasks,
        accounts: accounts ?? link.terms.accounts,
    };
    const persona = actsAs === null ? undefined : (actsAs ?? link.terms.actsAs);
    if (persona !== undefined) {
        terms.actsAs = persona;
    }
    const service = runAs === null ? undefined : (runAs ?? link.terms.runAs);
    if (service !== undefined) {
        terms.runAs = service;
    }
    const next: InboundLinkSummary = { ...link, label: label ?? link.label, terms };
    write(
        at,
        linksAt(at).map((candidate) => (candidate.id === id ? next : candidate)),
    );
    return next;
};

// Conversations it opened stay: they are this sandbox's now.
export const revokeLink = (at: URL, id: string) => {
    linkOf(at, id);
    write(
        at,
        linksAt(at).filter((link) => link.id !== id),
    );
    return { ok: true as const };
};

// Allowed, the task opens its conversation here and its first turn starts; declined, it is dropped.
export const decideRequest = (at: URL, id: string, requestId: string, { approve }: LinkRequestDecision): InboundLinkSummary => {
    const link = linkOf(at, id);
    const request = link.requests.find((candidate) => candidate.id === requestId) ?? refuse(`That task is no longer waiting.`, 404);
    if (approve) {
        sayOrBook({ prompt: request.task, conversationId: request.conversationId });
    }
    const next: InboundLinkSummary = {
        ...link,
        requests: link.requests.filter((candidate) => candidate !== request),
        conversations: link.conversations + (approve ? 1 : 0),
        lastUsedAt: approve ? Date.now() : link.lastUsedAt,
    };
    write(
        at,
        linksAt(at).map((candidate) => (candidate.id === id ? next : candidate)),
    );
    return next;
};
