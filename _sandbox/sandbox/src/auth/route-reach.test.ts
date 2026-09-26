import {
    ATTACHMENTS_DIR,
    CONTROL_SCOPES,
    type ContractRoute,
    type ControlScope,
    RAW_ROUTE_LIST,
    type RouteMeta,
    roleAtLeast,
    routeAccess,
    SANDBOX_ROUTES,
    sandboxRouteFor,
} from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { ControlTokens } from "./tokens/control-tokens.js";
import { controlScoped } from "./tokens/control-tokens.js";
import { grantsOf } from "./grants.js";
import { guestReach, routeFloor } from "./role-floor.js";

// Every route the contract declares, and what each gate in front of it decides (app.ts, role-floor.ts, grants.ts,
// control-tokens.ts), held to what the route's own RouteMeta says it should be. The expectation is read off the
// declaration by route-meta.ts's own words, never through the gates, so a route added to the contract is covered here
// without an edit, and a gate that stops honouring a field fails on every route declaring it.

// One row per route, keyed `METHOD /template`: door|bearer (does the session middleware let it through untouched),
// early|waits (does it answer before boot), stream|timed, its member floor, then guest, embedded, enrolment and every
// machine credential that reaches it: panel, agent, sync (sync-pipe: no heartbeat), and the control rungs editor, read,
// drive, land. An extension token reaches what its manifest declares, never what a route does, so it has no column.

const ROUTES: readonly ContractRoute[] = [...RAW_ROUTE_LIST, ...SANDBOX_ROUTES];

// Every RouteMeta field, and whether it decides who reaches the route. Keyed by the interface, so a field added there
// fails this file's typecheck until `declaredRowOf` says how it reads; `lane` and `front` say how a request travels,
// not who may send it.
const FIELDS = {
    auth: "reach",
    embedded: "reach",
    beforeBoot: "reach",
    stream: "reach",
    floor: "reach",
    guest: "reach",
    attachmentFloor: "reach",
    enrolment: "reach",
    agent: "reach",
    sync: "reach",
    panel: "reach",
    control: "reach",
    lane: "transport",
    front: "transport",
} as const satisfies Record<keyof RouteMeta, "reach" | "transport">;

// Every route's declaration itself is pinned in the contract's lock (contract.lock.json `access:` entries, read by
// route-meta.ts `routeAccess`), so lowering any route's floor or granting it a credential fails that lock check and
// needs a declared break; this file proves the gates honour what is declared. The reading itself is pinned here on one
// route per rule it applies: a default floor for a read and for a write, a declared floor on a read, each credential
// column, each control reach, a stream, a door, the upload's attachment row, and `ALL` read as a write. A row here
// changes only when that route's declaration does.
const PINNED = {
    "GET /health": "door early timed viewer panel read drive land",
    "POST /agent": "bearer waits timed collaborator guest panel editor drive land",
    "POST /agent/attach": "bearer waits stream viewer guest panel read drive land",
    "POST /agents/{id}/land": "bearer waits timed maintainer panel land",
    "POST /agents/{id}/place": "bearer waits timed maintainer panel",
    "GET /capabilities/{id}/otp": "bearer waits timed maintainer panel agent",
    "GET /listeners/{provider}/state": "bearer waits timed maintainer",
    "GET /members": "bearer waits timed viewer panel",
    "GET /sessions": "bearer waits timed viewer panel editor read drive land",
    "POST /system/passkeys/register": "bearer waits timed viewer guest enrolment panel",
    "POST /system/sync/report": "bearer waits timed maintainer panel sync",
    "GET /system/sync/ssh": "bearer waits timed viewer panel sync-pipe",
    "POST /webchat/{id}/message": "door waits timed maintainer embedded panel",
    "GET /workspace/media": "door waits timed viewer guest panel read drive land",
    "POST /workspace/upload": "bearer waits timed writer panel",
    "POST /workspace/upload ?path=<attachment>": "bearer waits timed collaborator guest panel",
    "ALL /x/*": "bearer waits timed maintainer panel",
} as const satisfies Record<string, string>;

// A route's concrete request: each `{param}` a sample segment, a raw route's `/*` two more, `ALL` read as a POST.
const requestOf = (route: ContractRoute): { readonly method: string; readonly path: string } => {
    let params = 0;
    const segments = route.path.split("/").map((segment) => {
        if (segment === "*") {
            return "a/b";
        }
        if (!segment.startsWith("{")) {
            return segment;
        }
        params += 1;
        return `p${params}`;
    });
    return { method: route.method === "ALL" ? "POST" : route.method, path: segments.join("/") };
};

// Where an upload lands inside ATTACHMENTS_DIR, for the row a route with an `attachmentFloor` gets beside its own.
const ATTACHMENT_TARGET = `${ATTACHMENTS_DIR}/u1/shot.png`;

const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

// The row a route's declaration asks for, read field by field as route-meta.ts documents each one and its default.
// `intoAttachments`: the request is an upload aimed inside ATTACHMENTS_DIR.
const declaredRowOf = (route: ContractRoute, intoAttachments: boolean): string => {
    const meta = route.meta;
    const { method } = requestOf(route);
    const floor = meta.floor ?? (isRead(method) ? "viewer" : "maintainer");
    const attachment = intoAttachments && meta.attachmentFloor !== undefined;
    const control = meta.control;
    // `read` sees what a viewer sees, `drive` does what a collaborator does, `land` adds its own presses; the rungs read
    // the route's floor, never an attachment's.
    const read = control !== "never" && (control === "read" || (isRead(method) && floor === "viewer"));
    const drive = read || (control !== "never" && roleAtLeast("collaborator", floor));
    const rungs = { editor: control === "editor", read, drive, land: drive || control === "land" } satisfies Record<ControlScope, boolean>;
    return [
        meta.auth === "door" ? "door" : "bearer",
        meta.beforeBoot === true ? "early" : "waits",
        meta.stream === true ? "stream" : "timed",
        attachment ? meta.attachmentFloor : floor,
        ...(meta.guest === true || attachment ? ["guest"] : []),
        ...(meta.embedded === true ? ["embedded"] : []),
        ...(meta.enrolment === true ? ["enrolment"] : []),
        ...(meta.panel === false ? [] : ["panel"]),
        ...(meta.agent === true ? ["agent"] : []),
        ...(meta.sync === undefined ? [] : [meta.sync === "poll" ? "sync" : "sync-pipe"]),
        ...CONTROL_SCOPES.filter((scope) => rungs[scope]),
    ].join(" ");
};

// The session half of a row: the meta read as app.ts reads it, then the floor and guest list the middleware applies.
const sessionGatesOf = (method: string, path: string, target: string | undefined): string[] => {
    const meta = sandboxRouteFor(method, path)?.meta ?? {};
    return [
        meta.auth === "door" ? "door" : "bearer",
        meta.beforeBoot === true ? "early" : "waits",
        meta.stream === true ? "stream" : "timed",
        routeFloor(method, path, target),
        ...(guestReach(method, path, target) ? ["guest"] : []),
        ...(meta.embedded === true ? ["embedded"] : []),
        ...(meta.enrolment === true ? ["enrolment"] : []),
    ];
};

// The machine half: which per-boot secrets, sync token and control rungs the grants admit to the request.
const machineGatesOf = async (method: string, path: string): Promise<string[]> => {
    let checkedIn: boolean | undefined;
    const grants = grantsOf({
        panelToken: "panel",
        agentToken: "agent",
        controlTokens: unstubbed<ControlTokens>("controlTokens", {}),
        verifySync: async (_presented, poll) => {
            checkedIn = poll;
            return { kind: "enrolled", id: "laptop", card: "laptop" };
        },
        verifyExtension: () => undefined,
    });
    const reaches = async (header: string, secret: string): Promise<boolean> =>
        (await grants.find((grant) => grant.header === header)?.authorize(secret, method, path))?.verdict === "ok";
    const panel = await reaches("x-intentic-panel", "panel");
    const agent = await reaches("x-intentic-agent", "agent");
    const sync = await reaches("x-intentic-sync", "sync");
    return [
        ...(panel ? ["panel"] : []),
        ...(agent ? ["agent"] : []),
        ...(sync ? [checkedIn === true ? "sync" : "sync-pipe"] : []),
        ...CONTROL_SCOPES.filter((scope) => controlScoped(scope, method, path)),
    ];
};

// What every gate decides about one request, spelled as a row.
const decisionsOf = async (method: string, path: string, target?: string): Promise<string> =>
    [...sessionGatesOf(method, path, target), ...(await machineGatesOf(method, path))].join(" ");

// Both halves for every route, and the attachment row beside each route that declares an `attachmentFloor`.
const rowsOf = async (): Promise<{ readonly decided: Record<string, string>; readonly declared: Record<string, string> }> => {
    const decided: Record<string, string> = {};
    const declared: Record<string, string> = {};
    for (const route of ROUTES) {
        const { method, path } = requestOf(route);
        const key = `${route.method} ${route.path}`;
        decided[key] = await decisionsOf(method, path);
        declared[key] = declaredRowOf(route, false);
        if (route.meta.attachmentFloor !== undefined) {
            decided[`${key} ?path=<attachment>`] = await decisionsOf(method, path, ATTACHMENT_TARGET);
            declared[`${key} ?path=<attachment>`] = declaredRowOf(route, true);
        }
    }
    return { decided, declared };
};

test("every declared route's own request resolves to it, and to nothing else", () => {
    const astray = ROUTES.filter((route) => {
        const { method, path } = requestOf(route);
        return sandboxRouteFor(method, path) !== route;
    });
    expect(astray.map((route) => route.name)).toEqual([]);
});

test("every route declares its policy only in fields the reading knows", () => {
    const unread = ROUTES.flatMap((route) =>
        Object.keys(route.meta)
            .filter((field) => !Object.hasOwn(FIELDS, field))
            .map((field) => `${route.method} ${route.path}: ${field}`),
    );
    expect(unread).toEqual([]);
});

// The lock records exactly the fields this file reads as reach, so a reach field the lock left out cannot move unseen.
test("the contract lock records every field that decides reach, and nothing else", () => {
    const reach = Object.entries(FIELDS)
        .filter(([, kind]) => kind === "reach")
        .map(([field]) => field);
    expect(Object.keys(routeAccess("GET", {})).toSorted()).toEqual(reach.toSorted());
});

test("every route is held to exactly the policy its own declaration states", async () => {
    const { decided, declared } = await rowsOf();
    expect(decided).toEqual(declared);
});

test("the reading gives each pinned route the row recorded for it", async () => {
    const { decided } = await rowsOf();
    expect(Object.fromEntries(Object.keys(PINNED).map((key) => [key, decided[key]]))).toEqual(PINNED);
});
