import { RAW_JSON_ROUTES, type RawJsonRoute } from "./raw-json-routes.js";
import { RAW_ROUTES, rawRouteUrl } from "./raw-routes.js";

// The table the editor calls the daemon's plain-JSON routes by: each entry is a route the daemon registers, says what it
// takes and answers, and parses what the editor reads off the wire.

const entries = Object.entries<RawJsonRoute>(RAW_JSON_ROUTES);
const keys = entries.map(([key]) => key);
const bodies = (route: RawJsonRoute): number => [route.input !== undefined, route.text === true, route.bytes === true].filter(Boolean).length;

describe(`RAW_JSON_ROUTES`, () => {
    it(`names only routes the daemon registers, so a typed call can never aim at a path nothing serves`, () => {
        expect(keys.filter((key) => !(key in RAW_ROUTES))).toEqual([]);
    });

    it(`gives a route one kind of body: JSON, a document, or bytes`, () => {
        expect(entries.filter(([, route]) => bodies(route) > 1).map(([key]) => key)).toEqual([]);
    });

    it(`takes a body only on a route that writes: a read has none to send`, () => {
        expect(entries.filter(([key, route]) => key.startsWith(`GET `) && bodies(route) > 0).map(([key]) => key)).toEqual([]);
    });

    it(`holds the routes the editor's rosters, access tab, uploads and dictation reach by key`, () => {
        expect(keys).toEqual(
            expect.arrayContaining([
                `GET /system/hosts`,
                `GET /system/webext`,
                `GET /system/phones`,
                `GET /system/runners`,
                `GET /system/sync`,
                `POST /system/sync/pair`,
                `GET /system/passkeys`,
                `POST /system/passkeys/register`,
                `GET /system/control/tokens`,
                `GET /bundles`,
                `POST /arrivals/plan`,
                `GET /speech/status`,
                `POST /workspace/upload`,
                `POST /workspace/upload-diff`,
            ]),
        );
    });

    it(`has a path every {param} of which is filled and encoded as one segment`, () => {
        expect(rawRouteUrl(`DELETE /system/hosts/{id}`, { id: `my laptop/1` })).toBe(`/system/hosts/my%20laptop%2F1`);
        expect(rawRouteUrl(`POST /system/runners/{id}/definition/sync`, { id: `r 1` })).toBe(`/system/runners/r%201/definition/sync`);
    });
});

describe(`what the rosters and pairings answer`, () => {
    it(`reads a peer's pairing from an older daemon, which sent a token and no code`, () => {
        expect(RAW_JSON_ROUTES[`POST /system/webext/pair`].output.parse({ token: `iht_x` })).toEqual({ token: `iht_x` });
        expect(RAW_JSON_ROUTES[`POST /system/hosts/pair`].output.parse({ token: `iht_x`, expiresIn: 600, code: `ABCD1234` })).toEqual({
            token: `iht_x`,
            expiresIn: 600,
            code: `ABCD1234`,
        });
    });

    it(`reads the sync pairing with the mode the daemon granted`, () => {
        expect(RAW_JSON_ROUTES[`POST /system/sync/pair`].output.parse({ token: `t`, expiresIn: 600, code: `ABCD1234`, mode: `mirror` })).toMatchObject({ mode: `mirror` });
        expect(() => RAW_JSON_ROUTES[`POST /system/sync/pair`].output.parse({ token: `t`, mode: `both` })).toThrow();
    });

    it(`reads a runner list, which two screens used to each describe themselves`, () => {
        expect(RAW_JSON_ROUTES[`GET /system/runners`].output.parse({ runners: [{ id: `r1`, online: false, parity: `unknown` }] })).toEqual({
            runners: [{ id: `r1`, online: false, parity: `unknown` }],
        });
        expect(() => RAW_JSON_ROUTES[`GET /system/runners`].output.parse({ runners: [{ id: `r1` }] })).toThrow();
    });

    it(`accepts the WebAuthn options only with the challenge the browser's own parser needs`, () => {
        expect(RAW_JSON_ROUTES[`POST /system/passkeys/register/options`].output.safeParse({ challenge: `AwQ`, rp: { id: `app.test`, name: `work` } }).success).toBe(true);
        expect(RAW_JSON_ROUTES[`POST /system/passkeys/register/options`].output.safeParse({ rp: { id: `app.test` } }).success).toBe(false);
        expect(RAW_JSON_ROUTES[`POST /system/passkeys/assert/options`].output.safeParse({ challenge: `AQID`, available: true }).success).toBe(true);
    });

    it(`reads a session recovery as the session and the codes still unspent`, () => {
        expect(RAW_JSON_ROUTES[`POST /system/session/recover`].output.parse({ token: `s`, expiresAt: 5, email: `a@example.com`, remaining: 3 })).toEqual({
            token: `s`,
            expiresAt: 5,
            email: `a@example.com`,
            remaining: 3,
        });
    });
});
