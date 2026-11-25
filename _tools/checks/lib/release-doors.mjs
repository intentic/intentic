/* DOORS WHOSE FAR END LAGS IN THE FIELD, judged against the last release rather than the branch's merge-base.

   A phone app, a browser extension, a runner or a machine agent updates on its own schedule (an app store, a person's
   browser, a machine that was asleep), and so does the netd inside every sandbox the edge and the editor still talk to.
   A shrink of what they speak breaks the copies already out there, whatever a commit message declares: the waiver
   contract-shrink.mjs takes for the rest of the contract (`!` or Breaking-Note) does not apply here. Such a shrink
   passes only once a retirement below names the surface and the far end's floor (peer-floors.mjs) has reached the
   release that stopped using it, so no supported copy still does. A door whose far end has no floor cannot shrink.

   A door's surface in contract.lock.json is every schema its contract and protocol modules name and its raw routes
   carry (an entry inlines what it references, so a nested change shows on it), the access entries of the routes its
   far end calls, and its `wire:` manifests;
   its golden files are compared whole. Not seen: a schema spelled inline in a contract (`z.object` inside `oc.input`),
   which the lock never records. */
import { shrunkSurfaces } from "../../constants/src/contract-shrink.mjs";
import { compareReleases } from "./peer-floors.mjs";

const CONTRACT = "_shared/sandbox-contract";

// peer: the PEERS id whose floor governs this door's far end, or undefined while it has none. routes: the path prefix of
// the routes its far end calls, those under it whose access says `auth: "door"` (raw-routes.ts), so the editor's own
// routes beside them (listing, pairing, removing) are not counted.
export const LAGGING_DOORS = [
    {
        id: "machine agent",
        modules: [`${CONTRACT}/src/contracts/device.contract.ts`, `${CONTRACT}/src/protocol/doors/host-protocol.ts`],
        routes: "/system/hosts/",
    },
    {
        id: "phone app",
        modules: [`${CONTRACT}/src/contracts/phone.contract.ts`, `${CONTRACT}/src/protocol/doors/phone-protocol.ts`],
        routes: "/system/phones/",
        goldens: [`${CONTRACT}/golden/phone-wire.json`],
    },
    {
        id: "browser extension",
        modules: [`${CONTRACT}/src/contracts/webext.contract.ts`, `${CONTRACT}/src/protocol/doors/webext-protocol.ts`],
        routes: "/system/webext/",
    },
    {
        id: "runner",
        modules: [`${CONTRACT}/src/contracts/runner.contract.ts`, `${CONTRACT}/src/protocol/doors/runner-protocol.ts`],
        routes: "/system/runners/",
    },
    // A sandbox's netd as the edge (the tunnel) and the editor (what a browser sees of netd) meet it: as old as the
    // oldest sandbox still served, which is the daemon floor, since the two ship in one image. `netd-wire` is netd and
    // Node inside one image, one version, so it is no door here.
    { id: "sandbox netd", peer: "daemon", wires: ["wire:tunnel", "wire:browser-wire"] },
];

// Surfaces retired from a lagging door: `surface` is a lock path (or a golden's `<file>:<path>`) or a prefix of one
// ending in `.`, `unusedSince` the first release of the far end that no longer reads or sends it. Kept until the
// surface is gone from every release a floor still covers.
const RETIRED = [];

const SCHEMA_NAME = /\b[A-Z][A-Za-z0-9]*Schema\b/gu;

const ACCESS = /^access:[A-Z]+ (\S+)$/u;
const RAW_JSON_LINE = /^\s*"[A-Z]+ (\/[^"]+)":(.*)$/gmu;

// The lock entries a door owns, from its modules' texts and raw-json-routes.ts's (the release's and this tree's both,
// so a schema the door dropped or renamed is still looked for) and the two locks (objects).
export const doorEntries = (door, { moduleTexts, rawJsonTexts, base, head }) => {
    const doorRoute = (path) => door.routes !== undefined && path.startsWith(door.routes);
    const routeKeys = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((key) => {
        const path = ACCESS.exec(key)?.[1];
        return path !== undefined && doorRoute(path) && (base[key]?.auth === "door" || head[key]?.auth === "door");
    });
    const doorPaths = new Set(routeKeys.map((key) => ACCESS.exec(key)[1]));
    const bodies = rawJsonTexts.flatMap((text) => [...text.matchAll(RAW_JSON_LINE)].filter(([, path]) => doorPaths.has(path)).map(([, , rest]) => rest));
    const names = new Set([...moduleTexts, ...bodies].flatMap((text) => text.match(SCHEMA_NAME) ?? []));
    const schemaKeys = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((key) => names.has(key) || (door.wires ?? []).includes(key));
    return [...schemaKeys, ...routeKeys].toSorted();
};

const covers = (retired, path) => retired.surface === path || (retired.surface.endsWith(".") && path.startsWith(retired.surface));

// The shrinks of one door between `base` and `head` (lock objects) that no retirement with a reached floor lets
// through, as lock paths. `goldens` is `[file, baseText, headText]` triples.
export const uncoveredShrinks = ({ door, base, head, entries, goldens = [], floors, retired = RETIRED }) => {
    const pick = (lock) => Object.fromEntries(entries.filter((key) => key in lock).map((key) => [key, lock[key]]));
    const gone = [
        ...shrunkSurfaces(pick(base), pick(head)),
        ...goldens.flatMap(([file, baseText, headText]) =>
            baseText === undefined
                ? []
                : headText === undefined
                  ? [`${file}:`]
                  : shrunkSurfaces(JSON.parse(baseText), JSON.parse(headText)).map((path) => `${file}:${path}`),
        ),
    ];
    const floor = door.peer === undefined ? undefined : floors.get(door.peer);
    return gone.filter(
        (path) => !retired.some((entry) => entry.door === door.id && covers(entry, path) && floor !== undefined && compareReleases(floor, entry.unusedSince) >= 0),
    );
};
