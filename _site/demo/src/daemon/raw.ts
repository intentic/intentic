import { AccessAskSchema, accessRefusal, MemberEmailSchema, memberAccess, tierOf } from "@intentic/sandbox-contract/schemas/members";
import { ProviderKeysApplySchema } from "@intentic/sandbox-contract/state/arrival";
import type { SandboxVitals } from "@intentic/sandbox-contract/netd/generated/browser-wire";
import type { VoicesView } from "@intentic/sandbox-contract/schemas/voice";
import { type RawContext, type RawRoutes, refuse } from "@intentic/contract-serve";
import { workspaceRoutes } from "./workspace/workspace.routes";
import { workspaceRaw } from "./workspace/rawFile";
import { webchatRoutes } from "./extensions/webchat.routes";
import { linksRoutes } from "./machine/links.routes";
import { machineRoutes } from "./machine/machine.routes";
import { signInRoutes } from "./account/signIn.routes";
import { KNOWLEDGE_BASE } from "../../vendor/knowledge/wire-types";
import {
    accessRequests,
    askAccess,
    type DemoGrant,
    grantProfile,
    grantAccess,
    grants,
    revokeAccess,
    settleAccess,
} from "../fixture/access";
import { DEMO_USER } from "../platform";
import { healthAt } from "../world/addresses";
import { HANDOVER_DOCX, HANDOVER_DOCX_BEFORE } from "../fixture/document";
import {
    deleteKnowledgeNote,
    knowledgeGraph,
    knowledgeNoteAt,
    knowledgeNotes,
    knowledgeOverview,
    knowledgeSearch,
    saveKnowledgeNote,
} from "../fixture/knowledge";
import { officeResponse } from "../fixture/offices/office";
import { vendoredBundle } from "../fixture/sandbox";
import { demoSelf } from "../floors";
import { json } from "../transport";
import { STARTED_AT } from "./board/roster";

// The routes the daemon serves outside oRPC that the app reaches here: file bytes, the members roster, control
// tokens, model keys found on the owner's devices, and the knowledge extension's own namespace.

// The document's bytes, as a viewer parses them: a picture of text would not do.
const documentBytes = (bytes: Uint8Array<ArrayBuffer>): Response =>
    new Response(bytes, { status: 200, headers: { "content-type": `application/vnd.openxmlformats-officedocument.wordprocessingml.document` } });

// The refusals the real daemon makes on the spot (auth/members/members.routes.ts), through the contract's own rules: an
// access no grant could make, a role that is not the tier the access makes, and a maintainer carrying a fence. A
// maintainer may carry a list of credentials or AI accounts, as anyone may: managing and spending are separate answers.
const grantMember = async ({ request }: RawContext): Promise<Response> => {
    const grant = (await request.json()) as Omit<DemoGrant, "credentials" | "aiAccounts"> & {
        credentials?: DemoGrant["credentials"] | `all`;
        aiAccounts?: DemoGrant["aiAccounts"] | `all`;
    };
    // Granting the person anything answers what they asked, as the daemon's grant does.
    settleAccess(grant.email);
    if (grant.profile !== undefined) {
        grantProfile(grant.email, grant.profile, grant.emailSignIn, grant.manages);
        return json({ members: grants() });
    }
    const access = memberAccess(grant);
    const refused = accessRefusal(access);
    if (refused !== undefined) {
        return refuse(refused, 400);
    }
    if (tierOf(access) !== grant.role) {
        return refuse(`the role does not match the access granted, which makes a ${tierOf(access)}`, 400);
    }
    if (grant.role === `maintainer` && grant.areas !== undefined) {
        return refuse(`a maintainer holds the owner's operating authority and cannot be fenced to part of the workspace`, 400);
    }
    grantAccess(grant.email, grant.role, grant.areas, grant.credentials, {
        agents: grant.agents,
        edit: grant.edit,
        emailSignIn: grant.emailSignIn,
        aiAccounts: grant.aiAccounts,
        manages: grant.manages,
    });
    return json({ members: grants() });
};

const revokeMember = async ({ request }: RawContext): Promise<Response> => {
    const { email } = MemberEmailSchema.parse(await request.json());
    revokeAccess(email);
    settleAccess(email);
    return json({ members: grants() });
};

// The demo's reader asking the owner for more, as the tier it is read as (`?as=`); the owner holds every access already.
const askForAccess = async ({ request }: RawContext): Promise<Response> => {
    if (demoSelf().role === `owner`) {
        return refuse(`the owner already holds every access here`, 400);
    }
    const asked = AccessAskSchema.safeParse(await request.json());
    if (!asked.success) {
        return refuse(`say what you are asking for, and where you were`, 400);
    }
    askAccess(DEMO_USER.email, asked.data);
    return json(demoSelf());
};

const dismissRequest = async ({ request }: RawContext): Promise<Response> => {
    settleAccess(MemberEmailSchema.parse(await request.json()).email);
    return json({ requests: accessRequests() });
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

// The voices a sandbox speaks with, as the Voice settings list them: a few of Kokoro's and Piper's, none of them
// installed yet, which is how a fresh sandbox reads. Speaking itself is daemon/voiceSay.ts.
const DEMO_VOICES: VoicesView = {
    voices: [
        { id: `kokoro/af_heart`, label: `Heart`, languages: [`en`], accent: `US`, gender: `female`, model: `kokoro-multi-lang-v1_0`, bytes: 349_906_910, installed: false },
        { id: `kokoro/am_michael`, label: `Michael`, languages: [`en`], accent: `US`, gender: `male`, model: `kokoro-multi-lang-v1_0`, bytes: 349_906_910, installed: false },
        { id: `kokoro/bf_emma`, label: `Emma`, languages: [`en`], accent: `GB`, gender: `female`, model: `kokoro-multi-lang-v1_0`, bytes: 349_906_910, installed: false },
        { id: `kokoro/ef_dora`, label: `Dora`, languages: [`es`], gender: `female`, model: `kokoro-multi-lang-v1_0`, bytes: 349_906_910, installed: false },
        { id: `piper/pl_PL-gosia-medium`, label: `Gosia`, languages: [`pl`], accent: `PL`, gender: `female`, model: `vits-piper-pl_PL-gosia-medium`, bytes: 67_211_182, installed: false },
        { id: `piper/pl_PL-darkman-medium`, label: `Darkman`, languages: [`pl`], accent: `PL`, gender: `male`, model: `vits-piper-pl_PL-darkman-medium`, bytes: 67_215_635, installed: false },
        { id: `piper/de_DE-thorsten-medium`, label: `Thorsten`, languages: [`de`], accent: `DE`, gender: `male`, model: `vits-piper-de_DE-thorsten-medium`, bytes: 67_214_254, installed: false },
    ],
    defaults: { en: `kokoro/af_heart`, es: `kokoro/ef_dora`, pl: `piper/pl_PL-gosia-medium`, de: `piper/de_DE-thorsten-medium` },
    provisioned: true,
};

// The routes the daemon serves outside oRPC that the app reaches here, keyed as the contract declares them.
export const raw = {
    // A booted daemon at a sandbox's address; no loopback shortcut, since nothing listens on this computer's ports.
    "GET /health": ({ url }) => {
        const health = healthAt(url);
        return health === undefined ? json({ error: `The demo has no local daemon to shortcut to.` }, 404) : json(health);
    },
    // A WebSocket can't carry a bearer header, so this ticket stands in for one per upgrade.
    "POST /system/ws-ticket": () => json({ ticket: `demo-ticket` }),
    "GET /speech/voices": () => json(DEMO_VOICES),
    // intentic-netd's own answer in a real sandbox: a daemon that is up, idle and never restarted.
    "GET /system/vitals": () =>
        json({
            node: `up`,
            lagMs: 1,
            restarts: 0,
            uptimeS: Math.floor((Date.now() - STARTED_AT) / 1000),
            pressure: { cpu: 0.3, memory: 0, io: 0.1 },
        } satisfies SandboxVitals),
    // A conversation's recorded document: the same bytes, since the fixture keeps one tree and every result is in it.
    "GET /agents/{id}/documents/raw": ({ url }) => workspaceRaw(url.searchParams.get(`path`) ?? ``),
    // Pre-flight for the upload queue; nothing here is ever a re-drop, so it always reports none to skip.
    "POST /workspace/upload-diff": () => json({ skip: [] }),
    // The one binary diff the demo carries whole: the handover document, both versions built in code.
    "GET /diff/raw": ({ url }) => documentBytes(url.searchParams.get(`which`) === `before` ? HANDOVER_DOCX_BEFORE : HANDOVER_DOCX),
    // The listed extensions' bundles, served as a daemon serves an installed checkout's `entry`; the loader blob-imports
    // them, so the demo runs the published bytes rather than a compiled-in copy.
    "GET /extensions/{id}/bundle": ({ param }) => vendoredBundle(param(`id`)),
    // The enforced roster, mutable: the Access tab pushes its grant here first, and a guest's chips come back from it.
    "GET /members": () => json({ owner: `ada@acme.dev`, members: grants() }),
    "POST /members": grantMember,
    "DELETE /members": revokeMember,
    // The demo's reader, as the tier it is read as (`?as=`, floors.ts): the owner manages everything.
    "GET /members/self": () => json(demoSelf()),
    "POST /members/requests": askForAccess,
    "GET /members/requests": () => json({ requests: accessRequests() }),
    "DELETE /members/requests": dismissRequest,
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
    // The two office cards and knowledge share the same namespace their real backends use.
    "ALL /x/*": (context) => officeResponse(context.request, context.url) ?? knowledge[`${context.request.method} ${context.url.pathname}`]?.(context),
    // Each area's routes from a file of its own (`<area>/<name>.routes.ts`), so they can be answered without touching this table.
    ...workspaceRoutes,
    ...webchatRoutes,
    ...linksRoutes,
    ...machineRoutes,
    ...signInRoutes,
} satisfies RawRoutes;
