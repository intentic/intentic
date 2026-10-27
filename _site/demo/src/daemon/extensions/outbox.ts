import { STATE_DIR } from "@intentic/constants";
import type { PublicFile, PublicList, PublishResult } from "@intentic/sandbox-contract/schemas/public";
import type { SharedConversation, ShareDetail, ShareList } from "@intentic/sandbox-contract/schemas/share";
import { SHARE_DIR, shareId } from "@intentic/sandbox-contract/ids/share-paths";
import { refuse } from "@intentic/contract-serve";
import { REVIEW_AGENT_ID } from "../../fixture/fleet";
import { PAGE_FILES } from "../../fixture/pages";
import { transcriptFor } from "../../fixture/transcripts";
import { fileBody, workspaceChildren } from "../../fixture/workspace";
import { demoQuiet, deskEdition, freshEdition } from "../../mode";
import { pushWorkspaceChanged } from "../broadcast";
import { roster } from "../board/roster";

// The workspace outbox, `public/`: what is published to anyone with the link, and the conversations shared as pages
// (which live in it too, under `conversations/`, but are listed and withdrawn through the share routes). Copies are
// kept here by path, so a publish is in the next list and an unpublish is gone from it.

// The outbox's address: `public-<slot>-<sandbox>.<zone>`, the shape every published link hangs off.
const OUTBOX_URL = `https://public-q4m8t2-demo.intentic.run`;
const OUTBOX = `public`;
const DAY = 86_400_000;

const urlOf = (path: string): string => `${OUTBOX_URL}/${path.split(`/`).map(encodeURIComponent).join(`/`)}`;

// What acme-shop has out already: the release notes it sent customers and the pricing sheet sales links to. The loud
// recording also holds a file the outbox refuses to serve, the state only its publisher is ever shown.
const seeded = (): PublicFile[] => {
    if (freshEdition || deskEdition) {
        return [];
    }
    const now = Date.now();
    const files: PublicFile[] = [
        { path: `release-notes-2.4.html`, size: 14_208, modifiedAt: now - 2 * DAY, url: urlOf(`release-notes-2.4.html`) },
        { path: `pricing-sheet.pdf`, size: 186_442, modifiedAt: now - 9 * DAY, url: urlOf(`pricing-sheet.pdf`) },
    ];
    if (!demoQuiet()) {
        files.push({ path: `deploy-notes.txt`, size: 912, modifiedAt: now - 5 * 3_600_000, blocked: `the contents look like a credential` });
    }
    return files;
};

let published: PublicFile[] | undefined;
const publishedNow = (): PublicFile[] => (published ??= seeded());

export const outboxList = (): PublicList => ({ url: OUTBOX_URL, files: publishedNow() });

// Every file under a workspace path, a folder walked as the copy takes it.
const filesUnder = (path: string): { path: string; size: number }[] => {
    const body = fileBody(path) ?? PAGE_FILES.get(path);
    if (body !== undefined) {
        return [{ path, size: new TextEncoder().encode(body).length }];
    }
    return workspaceChildren(path).entries.flatMap((entry) => filesUnder(entry.path));
};

// Copied in by its last segment, as the daemon copies it: republishing a name overwrites, so a link already sent keeps
// working.
export const publish = (path: string): PublishResult => {
    const clean = path.replace(/^\/+|\/+$/gu, ``);
    if (clean.startsWith(`${STATE_DIR}/`) && !clean.startsWith(`${STATE_DIR}/records/artifacts/`)) {
        refuse(`"${path}" is sandbox-private state and can never be published`);
    }
    if (clean === OUTBOX || clean.startsWith(`${OUTBOX}/`)) {
        refuse(`"${path}" is already published`, 400);
    }
    const files = filesUnder(clean);
    if (files.length === 0) {
        refuse(`"${path}" does not exist`, 404);
    }
    const name = clean.split(`/`).at(-1) ?? clean;
    if (name === SHARE_DIR) {
        refuse(`"${SHARE_DIR}" is where shared conversations are published, rename it first`, 400);
    }
    const base = clean.slice(0, clean.length - name.length);
    const copies = files.map((file) => ({ path: file.path.slice(base.length), size: file.size, modifiedAt: Date.now(), url: urlOf(file.path.slice(base.length)) }));
    const kept = new Set(copies.map((copy) => copy.path));
    published = [...publishedNow().filter((file) => !kept.has(file.path)), ...copies];
    pushWorkspaceChanged(`${OUTBOX}/${name}`);
    return { path: name, url: urlOf(name) };
};

// One entry withdrawn, a folder with everything in it.
export const unpublish = (path: string): void => {
    const before = publishedNow().length;
    published = publishedNow().filter((file) => file.path !== path && !file.path.startsWith(`${path}/`));
    if (published.length === before) {
        refuse(`"${path}" is not published`, 404);
    }
    pushWorkspaceChanged(`${OUTBOX}/${path}`);
};

// Shared conversations: a frozen snapshot each, its id minted fresh so a link is never guessable from the conversation.
// The loud recording has one out already, the soft-deletes change written up for the team, taken yesterday.
const SEEDED_SHARE_ID = `soft-deletes-for-users-3fa9c1d2`;
let shares: Omit<SharedConversation, `url`>[] | undefined;
const sharesNow = (): Omit<SharedConversation, `url`>[] =>
    (shares ??=
        demoQuiet() || deskEdition || freshEdition
            ? []
            : [
                  {
                      id: SEEDED_SHARE_ID,
                      conversationId: REVIEW_AGENT_ID,
                      title: `Soft deletes for users`,
                      detail: `messages`,
                      sharedAt: Date.now() - DAY,
                      messages: messagesOf(REVIEW_AGENT_ID, `messages`),
                  },
              ]);
const withUrl = (share: Omit<SharedConversation, `url`>): SharedConversation => ({ ...share, url: `${OUTBOX_URL}/${SHARE_DIR}/${share.id}/` });
const randomHex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, `0`)).join(``);

// What travels behind the link: the two speakers' words alone, or the whole record.
const messagesOf = (conversationId: string, detail: ShareDetail): number => {
    const messages = transcriptFor(conversationId, `shop`).messages;
    return detail === `everything` ? messages.length : messages.filter((message) => message.role === `user` || message.role === `assistant`).length;
};

const snapshot = (share: Omit<SharedConversation, `url` | `sharedAt` | `messages`>): SharedConversation => {
    if (!roster.agents.some((agent) => agent.id === share.conversationId)) {
        refuse(`unknown conversation`, 404);
    }
    const messages = messagesOf(share.conversationId, share.detail);
    if (messages === 0) {
        refuse(`this conversation has nothing to share yet`, 400);
    }
    const taken = { ...share, sharedAt: Date.now(), messages };
    const index = sharesNow().findIndex((entry) => entry.id === share.id);
    sharesNow().splice(index === -1 ? sharesNow().length : index, index === -1 ? 0 : 1, taken);
    pushWorkspaceChanged(`${OUTBOX}/${SHARE_DIR}/${share.id}/`);
    return withUrl(taken);
};

export const shareList = (): ShareList => ({ shares: sharesNow().map(withUrl) });

export const shareCreate = (conversationId: string, title: string, detail: ShareDetail): SharedConversation => {
    const trimmed = title.trim();
    if (trimmed === ``) {
        refuse(`a shared conversation needs a title`, 400);
    }
    return snapshot({ id: shareId(trimmed, randomHex()), conversationId, title: trimmed, detail });
};

export const shareUpdate = (id: string): SharedConversation => {
    const existing = sharesNow().find((share) => share.id === id) ?? refuse(`unknown share`, 404);
    return snapshot({ id, conversationId: existing.conversationId, title: existing.title, detail: existing.detail });
};

export const shareRemove = (id: string): void => {
    const index = sharesNow().findIndex((share) => share.id === id);
    if (index !== -1) {
        sharesNow().splice(index, 1);
        pushWorkspaceChanged(`${OUTBOX}/${SHARE_DIR}/${id}/`);
    }
};
