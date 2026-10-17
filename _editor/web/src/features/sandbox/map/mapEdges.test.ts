import { drawMap } from "./mapEdges";
import type { Rect } from "./mapGeometry";
import { buildReachMap, type Lighting, type ReachCapability, type ReachInput, lightingOf } from "./reachModel";
import type { MapLayout } from "./useMapLayout";

// The lines the stage draws from where its cards landed: one per way in and one per thing reached when the three columns
// stand side by side, one trunk each way when they stack, and only the focus's own lines lit.

const capability = (id: string, kind: ReachCapability[`kind`]): ReachCapability => ({ id, kind, title: id, icon: `bolt`, state: `Connected`, tone: `success` });

const input: ReachInput = {
    areas: [{ id: `site`, folders: [`web/site`] }],
    personas: [{ id: `owen`, capabilities: [`x-brand`], workspace: { startIn: `web/site` } }],
    capabilities: [capability(`github`, `cli`), capability(`postgres`, `cli`), capability(`x-brand`, `browser`)],
    secrets: [],
    models: [],
    roster: { owner: `ada@acme.dev`, members: [{ email: `sam@acme.dev`, role: `guest`, areas: [`site`] }] },
    invited: new Set([`sam@acme.dev`]),
    self: { email: `ada@acme.dev`, role: `owner` },
    now: 0,
};
const map = buildReachMap(input);

const rect = (left: number, top: number, width = 100, height = 30): Rect => ({ left, top, right: left + width, bottom: top + height });

// Principals in a column at x 0..100, the box at 200..400, the groups at 500..600; postgres folded out of sight.
const layout: MapLayout = {
    width: 600,
    height: 400,
    box: rect(200, 0, 200, 300),
    principals: new Map([
        [`person:ada@acme.dev`, { rect: rect(0, 0), kind: `person` as const }],
        [`person:sam@acme.dev`, { rect: rect(0, 40), kind: `person` as const }],
    ]),
    nodes: new Map([
        [`cap:github`, { rect: rect(500, 20), group: `services` as const }],
        [`bundle:services`, { rect: rect(500, 60), group: `services` as const }],
        [`cap:x-brand`, { rect: rect(500, 120), group: `accounts` as const }],
        [`persona:owen`, { rect: rect(220, 200), group: undefined }],
    ]),
    groups: new Map([
        [`services`, rect(500, 0, 100, 100)],
        [`accounts`, rect(500, 110, 100, 50)],
    ]),
};

const states = (lighting: Lighting | undefined): Record<string, string> =>
    Object.fromEntries(drawMap(layout, map, lighting, `across`, undefined).edges.map((edge) => [edge.key, `${edge.state}${edge.dashed ? `,dashed` : ``}`]));

describe(`side by side`, () => {
    it(`draws a line per way in and per thing reached, resting with nothing in focus`, () => {
        expect(states(undefined)).toEqual({
            "entry:person:ada@acme.dev": `rest`,
            // Sam's invite is not taken up yet: dashed.
            "entry:person:sam@acme.dev": `rest,dashed`,
            "reach:cap:github": `rest`,
            "reach:bundle:services": `rest`,
            "reach:cap:x-brand": `rest`,
        });
    });

    // Sam only chats, so everything outward is through Owen; the folded postgres lights its group's `more` row.
    it(`lights a principal's lines, dashes what it reaches only as a persona, and lights a fold hiding a reached thing`, () => {
        expect(states(lightingOf(map, input, { kind: `principal`, id: `person:sam@acme.dev` }))).toEqual({
            "entry:person:ada@acme.dev": `off`,
            "entry:person:sam@acme.dev": `on,dashed`,
            "reach:cap:github": `on,dashed`,
            "reach:bundle:services": `on,dashed`,
            "reach:cap:x-brand": `on,dashed`,
        });
    });

    it(`puts one door per kind of principal and one port per group on the box's edges`, () => {
        const drawn = drawMap(layout, map, undefined, `across`, undefined);
        expect(drawn.doors.map((door) => [door.key, door.at.x])).toEqual([[`door:person`, 200]]);
        expect(drawn.ports.map((port) => [port.key, port.at.x])).toEqual([
            [`port:services`, 400],
            [`port:accounts`, 400],
        ]);
    });

    it(`threads a focused node to what it is tied to`, () => {
        const drawn = drawMap(layout, map, lightingOf(map, input, { kind: `node`, id: `persona:owen` }), `across`, `persona:owen`);
        expect(drawn.edges.filter((edge) => edge.kind === `thread`).map((edge) => edge.key)).toEqual([`thread:cap:x-brand`]);
    });
});

describe(`stacked`, () => {
    it(`draws one trunk into the box and one out of it, through a single door and port`, () => {
        const drawn = drawMap(layout, map, lightingOf(map, input, { kind: `principal`, id: `person:ada@acme.dev` }), `down`, undefined);
        expect(drawn.edges.map((edge) => [edge.key, edge.state])).toEqual([
            [`trunk:in`, `on`],
            [`trunk:out`, `on`],
        ]);
        expect(drawn.doors.map((door) => door.at)).toEqual([{ x: 300, y: 0 }]);
        expect(drawn.ports.map((port) => port.at)).toEqual([{ x: 300, y: 300 }]);
    });
});

describe(`lanes`, () => {
    // Two groups below the box leave from neighbouring ports on its corner; each takes a lane of its own, and the one that
    // travels farther takes the lane nearer the box, so their runs sit side by side instead of on one line.
    it(`gives each group its own lane, the farthest nearest the box`, () => {
        const low: MapLayout = {
            ...layout,
            box: rect(200, 0, 200, 100),
            nodes: new Map([
                [`cap:github`, { rect: rect(500, 150), group: `services` as const }],
                [`cap:x-brand`, { rect: rect(500, 300), group: `accounts` as const }],
            ]),
            groups: new Map([
                [`services`, rect(500, 140, 100, 50)],
                [`accounts`, rect(500, 290, 100, 50)],
            ]),
        };
        const drawn = drawMap(low, map, undefined, `across`, undefined);
        const laneOf = (key: string): number | undefined => {
            const d = drawn.edges.find((edge) => edge.key === key)?.d ?? ``;
            return Number(/V/.test(d) ? d.split(` `).find((part) => part.startsWith(`Q`))?.slice(1) : undefined);
        };
        expect(laneOf(`reach:cap:x-brand`)).toBe(406);
        expect(laneOf(`reach:cap:github`)).toBe(414);
    });
});
