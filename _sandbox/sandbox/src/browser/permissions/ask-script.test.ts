import { createContext, runInContext } from "node:vm";
import { type JsonValue, parseJsonOr } from "@intentic/base/json";
import { askScript, parseAskMessage } from "./ask-script.js";

/* The page's half of a permission ask, run against stand-ins for the browser APIs it wraps: each kind of ask reaches the
   binding as one message and waits on the daemon's reply, a refusal reaches the page the way Chromium's own would, the
   camera is refused at once with the person told, and the binding itself is gone from the page's global. And the
   daemon's half: only the three messages are read, whatever else a page sends. */

const NAMES = { binding: "__binding_test", reply: "__reply_test" };

// A page with the APIs the script wraps, as small as the script reads them, and the binding the daemon installs.
const page = () => {
    const sent: unknown[] = [];
    const context = createContext({
        JSON,
        Promise,
        Map,
        Proxy,
        Reflect,
        Object,
        String,
        Error,
        __binding_test: (payload: string) => sent.push(JSON.parse(payload)),
    });
    runInContext(
        `
        globalThis.globalThis = globalThis;
        globalThis.DOMException = class extends Error { constructor(message, name) { super(message); this.name = name; } };
        // A property of the global, as a browser's is, rather than a script's own lexical class the wrapper could not replace.
        globalThis.Notification = class Notification { constructor(title) { this.title = title; } static requestPermission() { return Promise.resolve('native'); } };
        globalThis.Notification.permission = 'default';
        class Geolocation {
          getCurrentPosition(success) { success({ coords: { latitude: 1, longitude: 2 } }); }
          watchPosition(success) { success({ coords: { latitude: 1, longitude: 2 } }); return 77; }
          clearWatch(id) { globalThis.cleared = id; }
        }
        globalThis.Geolocation = Geolocation;
        class Clipboard { readText() { return Promise.resolve('clipboard text'); } read() { return Promise.resolve([]); } }
        globalThis.Clipboard = Clipboard;
        class MediaDevices { getUserMedia() { return Promise.resolve('a stream'); } }
        globalThis.MediaDevices = MediaDevices;
        class Navigator {}
        globalThis.Navigator = Navigator;
        `,
        context,
    );
    runInContext(askScript(NAMES), context);
    // What the page's code answered, as JSON: values made in the page's own realm compare as plain data here.
    const run = async (code: string): Promise<JsonValue | undefined> => {
        const value: unknown = await runInContext(code, context);
        return value === undefined ? undefined : parseJsonOr(JSON.stringify(value), undefined);
    };
    const reply = (id: number, answer: string): void => {
        runInContext(`globalThis.${NAMES.reply}(${String(id)}, ${JSON.stringify(answer)})`, context);
    };
    return { sent, run, reply };
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the page's asks", () => {
    test("the binding is taken off the page's global, and the reply is not enumerable", async () => {
        const { run } = page();
        expect(await run(`typeof globalThis.${NAMES.binding}`)).toBe("undefined");
        expect(await run(`Object.keys(globalThis).includes(${JSON.stringify(NAMES.reply)})`)).toBe(false);
    });

    test("a notification ask waits on the daemon and answers what it said", async () => {
        const { sent, run, reply } = page();
        const asked = run(`Notification.requestPermission()`);
        await tick();
        expect(sent).toEqual([{ type: "ask", id: 1, permission: "notifications" }]);
        reply(1, "granted");
        expect(await asked).toBe("granted");
    });

    test("a wrapped function reads as native code", async () => {
        const { run } = page();
        expect(await run(`Notification.requestPermission.toString()`)).toBe("function requestPermission() { [native code] }");
    });

    test("a location refused reaches the error callback as PERMISSION_DENIED, and the lookup never runs", async () => {
        const { sent, run, reply } = page();
        await run(`globalThis.got = []; new Geolocation().getCurrentPosition((p) => got.push('position'), (e) => got.push(e.code));`);
        await tick();
        expect(sent).toEqual([{ type: "ask", id: 1, permission: "geolocation" }]);
        reply(1, "denied");
        await tick();
        expect(await run(`got`)).toEqual([1]);
    });

    test("a location allowed runs the browser's own lookup", async () => {
        const { run, reply } = page();
        await run(`globalThis.got = []; new Geolocation().getCurrentPosition((p) => got.push(p.coords.latitude));`);
        await tick();
        reply(1, "granted");
        await tick();
        expect(await run(`got`)).toEqual([1]);
    });

    test("a watch answers its id at once and clears the real one it stands for", async () => {
        const { run, reply } = page();
        expect(await run(`globalThis.geo = new Geolocation(); globalThis.id = geo.watchPosition(() => undefined); id`)).toBe(1);
        await tick();
        reply(1, "granted");
        await tick();
        await run(`geo.clearWatch(id)`);
        expect(await run(`globalThis.cleared`)).toBe(77);
    });

    test("reading the clipboard asks first, and a refusal is NotAllowedError", async () => {
        const { sent, run, reply } = page();
        const read = run(`new Clipboard().readText().catch((e) => e.name)`);
        await tick();
        expect(sent).toEqual([{ type: "ask", id: 1, permission: "clipboard-read" }]);
        reply(1, "denied");
        expect(await read).toBe("NotAllowedError");
    });

    test("the camera is refused at once as no device, and the person is told", async () => {
        const { sent, run } = page();
        expect(await run(`new MediaDevices().getUserMedia({ video: true, audio: true }).catch((e) => e.name)`)).toBe("NotFoundError");
        expect(sent).toEqual([{ type: "unavailable", permission: "camera" }]);
    });

    test("a notification shown once allowed is reported", async () => {
        const { sent, run } = page();
        await run(`Notification.permission = 'granted'; new Notification('Build passed', { body: 'All green' })`);
        expect(sent).toEqual([{ type: "notify", title: "Build passed", body: "All green" }]);
    });
});

describe("what the daemon reads off the binding", () => {
    test("the three messages, and nothing else", () => {
        expect(parseAskMessage(`{"type":"ask","id":3,"permission":"geolocation"}`)).toEqual({ type: "ask", id: 3, permission: "geolocation" });
        expect(parseAskMessage(`{"type":"unavailable","permission":"microphone"}`)).toEqual({ type: "unavailable", permission: "microphone" });
        expect(parseAskMessage(`{"type":"ask","id":3,"permission":"camera"}`)).toBeUndefined();
        expect(parseAskMessage(`{"type":"grant","permission":"geolocation"}`)).toBeUndefined();
        expect(parseAskMessage(`not json`)).toBeUndefined();
    });

    test("a notification's words are cut short", () => {
        const long = parseAskMessage(JSON.stringify({ type: "notify", title: "t".repeat(500), body: "b".repeat(5000) }));
        expect(long).toEqual({ type: "notify", title: "t".repeat(120), body: "b".repeat(400) });
    });
});
