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
import { demoPersonas } from "../extensions/personas";
import { sayOrBook } from "../board/queue";

// Other sandboxes linked into this one (the Access tab's Linked sandboxes, Sandbox ▸ Map), held as the daemon's link
// store holds them: minted with a token shown once, re-termed, revoked, and the tasks a link's terms hold for the owner
// allowed (the task opens its conversation here and starts) or declined. The support desk's sandbox hands this one tasks
// as Maya, one of them waiting for the owner's yes.

let links: InboundLinkSummary[] = [
    {
        id: `lnk_support`,
        label: `support-desk`,
        from: { sandboxId: `sbx_support`, url: `https://support-desk.acme.dev` },
        terms: { actsAs: `maya-support`, approve: true, turnsPerHour: 20 },
        createdAt: Date.now() - 20 * 24 * 3_600_000,
        createdBy: DEMO_USER.email,
        lastUsedAt: Date.now() - 2 * 3_600_000,
        conversations: 4,
        requests: [{ id: `req_1`, conversationId: `link-refund-macro`, task: `Draft the refund macro for damaged parcels`, askedAt: Date.now() - 40 * 60_000 }],
    },
];

export const linksList = (): InboundLinksList => ({ links: [...links] });

const linkOf = (id: string): InboundLinkSummary => links.find((link) => link.id === id) ?? refuse(`no such link`, 404);

// As the daemon refuses a persona the sandbox does not hold, rather than minting a link that could never run.
const checkPersona = (actsAs: string | null | undefined): void => {
    if (actsAs !== null && actsAs !== undefined && !demoPersonas.some((persona) => persona.id === actsAs)) {
        refuse(`No persona here is called ${actsAs}.`, 400);
    }
};

export const mintLink = ({ label, from, terms }: InboundLinkMint): InboundLinkMinted => {
    checkPersona(terms?.actsAs);
    const id = `lnk_${crypto.randomUUID().slice(0, 8)}`;
    const summary: InboundLinkSummary = { id, label, terms: LinkTermsSchema.parse(terms ?? {}), createdAt: Date.now(), createdBy: DEMO_USER.email, conversations: 0, requests: [] };
    if (from !== undefined) {
        summary.from = from;
    }
    links = [...links, summary];
    return { id, token: `ilk_${crypto.randomUUID().replaceAll(`-`, ``)}` };
};

// Whole fields replaced, the rest kept; `null` takes the persona or the service off.
export const updateLink = (id: string, { label, actsAs, runAs, approve, turnsPerHour }: InboundLinkTermsUpdate): InboundLinkSummary => {
    checkPersona(actsAs);
    const link = linkOf(id);
    const terms: InboundLinkSummary[`terms`] = { approve: approve ?? link.terms.approve, turnsPerHour: turnsPerHour ?? link.terms.turnsPerHour };
    const persona = actsAs === null ? undefined : (actsAs ?? link.terms.actsAs);
    if (persona !== undefined) {
        terms.actsAs = persona;
    }
    const service = runAs === null ? undefined : (runAs ?? link.terms.runAs);
    if (service !== undefined) {
        terms.runAs = service;
    }
    const next: InboundLinkSummary = { ...link, label: label ?? link.label, terms };
    links = links.map((candidate) => (candidate.id === id ? next : candidate));
    return next;
};

// Conversations it opened stay: they are this sandbox's now.
export const revokeLink = (id: string) => {
    linkOf(id);
    links = links.filter((link) => link.id !== id);
    return { ok: true as const };
};

// Allowed, the task opens its conversation here and its first turn starts; declined, it is dropped.
export const decideRequest = (id: string, requestId: string, { approve }: LinkRequestDecision): InboundLinkSummary => {
    const link = linkOf(id);
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
    links = links.map((candidate) => (candidate.id === id ? next : candidate));
    return next;
};
