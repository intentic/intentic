import { RAW_ROUTES, rawRoutePath } from "./raw-routes.js";
import { parseVitals, type SandboxVitals, VITALS_PATH } from "./vitals.js";

// The JSON browser-wire's own test pins (`vitals_are_the_camel_case_json_the_editor_parses_with_null_for_what_is_unknown`):
// what the front writes, the editor reads.
const RUST_GOLDEN_JSON = `{"node":"restarting","lagMs":null,"restarts":2,"uptimeS":3600,"pressure":{"cpu":12.34,"memory":0.0,"io":1.5}}`;

const up: SandboxVitals = { node: "up", lagMs: 12, restarts: 0, uptimeS: 60, pressure: { cpu: 0.29, memory: 0.49, io: 0.88 } };

it("reads the front's own answer as it writes it", () => {
    expect(parseVitals(JSON.parse(RUST_GOLDEN_JSON))).toEqual({
        node: "restarting",
        lagMs: null,
        restarts: 2,
        uptimeS: 3600,
        pressure: { cpu: 12.34, memory: 0, io: 1.5 },
    });
    expect(parseVitals(up)).toEqual(up);
    expect(parseVitals({ ...up, node: "starting" })?.node).toBe("starting");
});

it("reads a lag or pressure it cannot make out as unknown, and keeps the rest", () => {
    const { lagMs: _lag, pressure: _pressure, ...bare } = up;
    expect(parseVitals(bare)).toEqual({ ...bare, lagMs: null, pressure: null });
    expect(parseVitals({ ...up, lagMs: -1, pressure: { cpu: 1 } })).toEqual({ ...up, lagMs: null, pressure: null });
    // A later front's extra fields are not this reader's business.
    expect(parseVitals({ ...up, since: "later" })).toEqual(up);
});

it("is undefined for anything that is not the front's answer", () => {
    // An older sandbox forwards the path to Node, which answers 404 as JSON, or a preview's HTML page.
    expect(parseVitals({ error: "Not Found" })).toBeUndefined();
    expect(parseVitals("<!doctype html><title>Not found</title>")).toBeUndefined();
    expect(parseVitals(null)).toBeUndefined();
    expect(parseVitals(42)).toBeUndefined();
    expect(parseVitals([up])).toBeUndefined();
    expect(parseVitals({ ...up, node: "crashed" })).toBeUndefined();
    expect(parseVitals({ ...up, restarts: -1 })).toBeUndefined();
    expect(parseVitals({ ...up, uptimeS: 1.5 })).toBeUndefined();
    expect(parseVitals({ ...up, restarts: "2" })).toBeUndefined();
});

it("is a route the front serves itself, with no credential, before the daemon boots", () => {
    expect(rawRoutePath("GET /system/vitals")).toBe(VITALS_PATH);
    expect(RAW_ROUTES["GET /system/vitals"]).toEqual({ auth: "door", beforeBoot: true, front: true });
});
