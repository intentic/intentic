import { type PasskeysList, ProviderKeysApplySchema, type SandboxVitals } from "@intentic/sandbox-contract";
import { type RawContext, type RawRoutes, refuse } from "@intentic/contract-serve";
import { KNOWLEDGE_BASE } from "../../vendor/knowledge/wire-types";
import { type DemoGrant, grantAccess, grants, revokeAccess } from "../fixture/access";
import { SEPTEMBER_PRINT_DOCX, SEPTEMBER_PRINT_PATH, SUPPLIER_LETTER_DOCX, SUPPLIER_LETTER_PATH } from "../fixture/desk";
import { HANDOVER_CHANGE_PATH, HANDOVER_DOCX, HANDOVER_DOCX_BEFORE, HANDOVER_PATH } from "../fixture/document";
import {
    deleteKnowledgeNote,
    knowledgeGraph,
    knowledgeNoteAt,
    knowledgeNotes,
    knowledgeOverview,
    knowledgeSearch,
    saveKnowledgeNote,
} from "../fixture/knowledge";
import { PAGE_FILES } from "../fixture/pages";
import { demoEnvironment, demoEnvironmentContents, vendoredBundle } from "../fixture/sandbox";
import { fileBody, writeFile } from "../fixture/workspace";
import { demoQuiet } from "../mode";
import { json } from "../transport";
import { STARTED_AT } from "./roster";

// The routes the daemon serves outside oRPC that the app reaches here: file bytes, the members roster, control
// tokens, passkeys, arrivals, and the knowledge extension's own namespace.

// The document's bytes, as a viewer parses them: a picture of text would not do.
const documentBytes = (bytes: Uint8Array<ArrayBuffer>): Response =>
    new Response(bytes, { status: 200, headers: { "content-type": `application/vnd.openxmlformats-officedocument.wordprocessingml.document` } });

// Report screenshots (svg keeps them a few kilobytes and sharp at any size) and the Word documents, the only paths here
// whose bytes are bytes: a viewer parses them, so text would not do.
const workspaceRaw = (path: string): Response => {
    const page = PAGE_FILES.get(path);
    if (page !== undefined) {
        return new Response(page, { status: 200, headers: { "content-type": `text/html; charset=utf-8` } });
    }
    if (path === SUPPLIER_LETTER_PATH) {
        return documentBytes(SUPPLIER_LETTER_DOCX);
    }
    if (path === SEPTEMBER_PRINT_PATH) {
        return documentBytes(SEPTEMBER_PRINT_DOCX);
    }
    if (path === HANDOVER_PATH || path === HANDOVER_CHANGE_PATH) {
        return documentBytes(HANDOVER_DOCX);
    }
    const body = fileBody(path) ?? refuse(`No such file: ${path}`, 404);
    return new Response(body, { status: 200, headers: { "content-type": path.endsWith(`.svg`) ? `image/svg+xml` : `text/plain; charset=utf-8` } });
};

// Every picture in this fixture is already small, so a tile is the file itself; only SVG is refused, as the daemon does.
const workspaceThumb = (path: string): Response => (path.endsWith(`.svg`) ? refuse(`not a picture this can draw`, 415) : workspaceRaw(path));

// The refusals the real daemon makes on the spot (auth/members/members.routes.ts): a writer and a guest each need a
// fence, since for both the areas are the tier rather than a narrowing of it, and a maintainer cannot carry one at
// all, since it holds the owner's operating authority and a folder fence over it would enforce nothing.
const grantMember = async ({ request }: RawContext): Promise<Response> => {
    const grant = (await request.json()) as DemoGrant;
    if ((grant.areas?.length ?? 0) === 0 && (grant.role === `writer` || grant.role === `guest`)) {
        return refuse(`a ${grant.role} needs at least one area`, 400);
    }
    if (grant.role === `maintainer` && grant.areas !== undefined) {
        return refuse(`a maintainer holds the owner's operating authority and cannot be fenced to part of the workspace`, 400);
    }
    grantAccess(grant.email, grant.role, grant.areas);
    return json({ members: grants() });
};

const revokeMember = async ({ request }: RawContext): Promise<Response> => {
    revokeAccess(((await request.json()) as { email: string }).email);
    return json({ members: grants() });
};

// Served under the extension's own namespace and paths, so a boundary move is a compile error, not an empty panel.
// Answers come from the extension's real engine over fixture/knowledge.ts.
const knowledge: Readonly<Record<string, (context: RawContext) => Response | Promise<Response>>> = {
    [`GET ${KNOWLEDGE_BASE}/overview`]: () => json(knowledgeOverview()),
    [`GET ${KNOWLEDGE_BASE}/notes`]: () => json({ notes: knowledgeNotes() }),
    [`GET ${KNOWLEDGE_BASE}/search`]: ({ url }) => json({ hits: knowledgeSearch(url.searchParams) }),
    [`GET ${KNOWLEDGE_BASE}/note`]: ({ url }) => json(knowledgeNoteAt(url.searchParams.get(`path`) ?? ``) ?? refuse(`No such note.`, 404)),
    [`GET ${KNOWLEDGE_BASE}/graph`]: ({ url }) => json(knowledgeGraph(url.searchParams)),
    // Refuses exactly what the real backend refuses: a path outside the knowledge folder, or not a note.
    [`PUT ${KNOWLEDGE_BASE}/note`]: async ({ request }) => {
        const { path, content } = (await request.json()) as { path?: string; content?: string };
        return saveKnowledgeNote(Date.now(), path ?? ``, content ?? ``)
            ? json({ ok: true })
            : refuse(`That is not a markdown note inside the knowledge folder.`, 400);
    },
    [`DELETE ${KNOWLEDGE_BASE}/note`]: async ({ request }) => {
        const path = ((await request.json()) as { path?: string }).path ?? ``;
        return deleteKnowledgeNote(Date.now(), path) ? json({ ok: true }) : refuse(`No such note.`, 404);
    },
    // The demo knowledge base already started, so this only ever answers nothing to write.
    [`POST ${KNOWLEDGE_BASE}/seed`]: () => json({ written: [] }),
};

// The API keys the visitor's laptop holds, for GET /arrivals/keys: the hint and digest only, as the daemon answers.
const DEMO_KEYS = [
    { id: `key-3f9a2c41d07e8b55`, provider: `openrouter`, label: `OpenRouter`, source: `hermes`, host: `laptop`, hint: `9c2e`, applicable: true },
] as const;
const demoKeysAdded = new Set<string>();

/** A mutation with nothing to report: do it, then answer the daemon's own `{ ok: true }`. */
const okAfter = (write: () => void): { ok: true } => {
    write();
    return { ok: true };
};

// The routes the daemon serves outside oRPC that the app reaches here, keyed as the contract declares them.
export const raw = {
    // No loopback shortcut here; the demo daemon is only ever at its own origin.
    "GET /health": () => json({ error: `The demo has no local daemon to shortcut to.` }, 404),
    // A WebSocket can't carry a bearer header, so this ticket stands in for one per upgrade.
    "POST /system/ws-ticket": () => json({ ticket: `demo-ticket` }),
    // No phone is paired in the demo, but adding the Android card mints a pairing, so its QR code can be seen; nothing
    // can ever redeem this one.
    "GET /system/phones": () => json({ phones: [] }),
    "POST /system/phones/pair": () => json({ token: `demo-pairing-never-redeemable`, expiresIn: 600_000 }),
    // intentic-netd's own answer in a real sandbox: a daemon that is up, idle and never restarted.
    "GET /system/vitals": () =>
        json({
            node: `up`,
            lagMs: 1,
            restarts: 0,
            uptimeS: Math.floor((Date.now() - STARTED_AT) / 1000),
            pressure: { cpu: 0.3, memory: 0, io: 0.1 },
        } satisfies SandboxVitals),
    // Screenshot bytes for an <img>, served here rather than from /public.
    "GET /workspace/raw": ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``),
    // A picture at tile size, answered as the daemon answers it: SVG is refused (415) for the client to draw the file.
    "GET /workspace/thumb": ({ url }) => workspaceThumb(url.searchParams.get(`path`) ?? ``),
    // Pre-flight for the upload queue; nothing here is ever a re-drop, so it always reports none to skip.
    "POST /workspace/upload-diff": () => json({ skip: [] }),
    "POST /workspace/upload": async ({ request, url }) => {
        const body = await request.text();
        return json(okAfter(() => writeFile(url.searchParams.get(`path`) ?? ``, body)));
    },
    // The one binary diff the demo carries whole: the handover document, both versions built in code.
    "GET /diff/raw": ({ url }) => documentBytes(url.searchParams.get(`which`) === `before` ? HANDOVER_DOCX_BEFORE : HANDOVER_DOCX),
    // The listed extensions' bundles, served as a daemon serves an installed checkout's `entry`; the loader blob-imports
    // them, so the demo runs the published bytes rather than a compiled-in copy.
    "GET /extensions/{id}/bundle": ({ param }) => vendoredBundle(param(`id`)),
    // The enforced roster, mutable: the Access tab pushes its grant here first, and a guest's chips come back from it.
    "GET /members": () => json({ members: grants() }),
    "POST /members": grantMember,
    "DELETE /members": revokeMember,
    // Two tokens on the roster (one unused, one expiring) make the roster's states visible; a mint answers
    // the once-shown value.
    "GET /system/control/tokens": () =>
        json({
            tokens: [
                {
                    id: `ct_ci`,
                    label: `nightly CI`,
                    scope: `drive`,
                    createdAt: Date.now() - 12 * 24 * 3_600_000,
                    createdBy: `ada@acme.dev`,
                    expiresAt: Date.now() + 78 * 24 * 3_600_000,
                    lastUsedAt: Date.now() - 6 * 3_600_000,
                },
                { id: `ct_zed`, label: `Zed on laptop`, scope: `editor`, createdAt: Date.now() - 40 * 24 * 3_600_000, createdBy: `ada@acme.dev` },
            ],
        }),
    "POST /system/control/tokens": () => json({ id: `ct_new`, token: `***` }),
    "DELETE /system/control/tokens/{id}": () => json({ ok: true }),
    // Read by the Access tab on first render, so a refusal here painted an error box into every picture of it. One
    // passkey the owner added from a laptop that syncs it, and no rule that a passkey is the only way in; registering
    // another still refuses, since the demo's session is seeded and there is nothing for an authenticator to prove.
    "GET /system/passkeys": () =>
        json({
            passkeys: [
                {
                    id: `pk_demo_macbook`,
                    email: `ada@acme.dev`,
                    label: `MacBook Air`,
                    rpId: `app.intentic.dev`,
                    createdAt: Date.now() - 41 * 24 * 3_600_000,
                    lastUsedAt: Date.now() - 2 * 3_600_000,
                    backedUp: true,
                },
            ],
            required: false,
        } satisfies PasskeysList),
    "GET /environment": () => json(demoEnvironment({ proposal: !demoQuiet(`proposal`) })),
    "GET /environment/contents": () => json(demoEnvironmentContents({ settled: demoQuiet(`proposal`) })),
    // Read on first render; a published workspace and empty exports/computers are the tab's default states
    // before the visitor clicks anything.
    "GET /definition/workspace": () => json({ remote: `https://github.com/acme/intentic-sandbox-ada.git`, branch: `main`, hosts: [`github.com`] }),
    "GET /bundles": () => json({ exports: [] }),
    "GET /arrivals/hosts": () => json({ hosts: [] }),
    // A model key on the visitor's laptop, offered by the connect view's "Found on this computer"; adding it is
    // remembered for the tab, though no endpoint joins the picker, since the demo serves no models of its own.
    "GET /arrivals/keys": () => json({ keys: DEMO_KEYS.map((key) => ({ ...key, added: demoKeysAdded.has(key.id) })) }),
    "POST /arrivals/keys/apply": async ({ request }) => {
        const ids = ProviderKeysApplySchema.safeParse(await request.json()).data?.ids ?? [];
        const known = ids.filter((id) => DEMO_KEYS.some((key) => key.id === id));
        for (const id of known) {
            demoKeysAdded.add(id);
        }
        return json({
            added: known.map((id) => ({ id, capability: DEMO_KEYS.find((key) => key.id === id)?.provider ?? `endpoint` })),
            failed: ids.filter((id) => !known.includes(id)).map((id) => ({ id, error: `that key is no longer on a connected device` })),
        });
    },
    // The checklist an upload produces: one row per repo, one for workspace files, one for history, plus two
    // steps the arrival can't do for the owner.
    "POST /arrivals/plan": () =>
        json({
            source: `bundle`,
            token: `demo-arrival`,
            name: `acme-shop`,
            carriesSecrets: true,
            items: [
                {
                    id: `bundle:files`,
                    group: `files`,
                    label: `Workspace files`,
                    detail: `Everything in /work that is not one of the repositories below, and the workspace repo's own history — 4,213 files, 41.8 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [`STRIPE_SECRET_KEY`],
                },
                {
                    id: `repo:acme-shop`,
                    group: `repo`,
                    label: `Repository acme-shop`,
                    detail: `Its working tree and its full git history — 1,904 files, 12.2 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
                {
                    id: `repo:design-system`,
                    group: `repo`,
                    label: `Repository design-system`,
                    detail: `Its working tree and its full git history — 22,610 files, 6.1 GB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
                {
                    id: `bundle:history`,
                    group: `history`,
                    label: `Sandbox history`,
                    detail: `Transcripts, checkpoint timelines and ledgers, the part nothing else can reproduce — 8,802 files, 310.4 MB`,
                    applicable: true,
                    recommended: true,
                    secrets: [],
                },
            ],
            refused: [`history/session-secret (this sandbox does not accept identity files)`],
            needsAction: [
                {
                    subject: `Rebuild the environment image`,
                    detail: `The overlay Dockerfile travels, but the IMAGE it describes is built outside the container. Open the Environment card and run the rebuild command it shows.`,
                },
                {
                    subject: `Reconnect capabilities`,
                    detail: `Each connection arrives listed but unauthenticated. Open these on the Capabilities view and re-enter the credential each one asks for: github (git), linear (mcp).`,
                },
            ],
        }),
    // An extension backend's namespace: only the knowledge extension's is fixtured.
    "ALL /x/*": (context) => knowledge[`${context.request.method} ${context.url.pathname}`]?.(context),
} satisfies RawRoutes;
