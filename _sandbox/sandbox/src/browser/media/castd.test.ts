import { pollUntil } from "@intentic/base/async";
import { castdBinary, castdDroppedAt, castSessionOf, configureCastd, dropCastdViewers, ensureCastd, IMAGE_CASTD, stopCastd } from "./castd.js";
import { castControl } from "./castd-control.js";
import { castdArgs, CastdProcess, type CastdSpec } from "./castd-process.js";
import { answering, castAnswer, fakeCastd, GEOMETRY_SCREEN } from "./castd.testing.js";

// castd's lifecycle against a fake spawner: started, adopted after a daemon restart, started again when it dies and
// stopped with its display. The real binary is the integration suite's (castd.integration.test.ts).

const SCREEN: CastdSpec = { key: "_own", display: ":99", framing: { kind: "screen" }, maxSize: { width: 3840, height: 2400 } };
const CROP: CastdSpec = { key: "agent@example.com", display: ":100", framing: { kind: "crop", rect: { x: 1280, y: 720, width: 1280, height: 880 } } };

// A bound on waits for what the fake does at once or after castd's backoff floor (0.5-1 s); never a latency claim.
const SETTLED = { intervalMs: 10, timeoutMs: 5_000 };

describe("castdBinary", () => {
    test("INTENTIC_CASTD names it, and an empty one turns castd off", () => {
        const exists = (path: string): boolean => path === "/custom/castd" || path === IMAGE_CASTD;
        expect(castdBinary({ INTENTIC_CASTD: "/custom/castd" }, exists)).toBe("/custom/castd");
        expect(castdBinary({ INTENTIC_CASTD: "" }, exists)).toBeUndefined();
        expect(castdBinary({ INTENTIC_CASTD: "/missing/castd" }, exists)).toBeUndefined();
    });

    test("else the image's, else a build in the checkout, else none, which keeps every window on the old path", () => {
        expect(castdBinary({}, (path) => path === IMAGE_CASTD)).toBe(IMAGE_CASTD);
        expect(castdBinary({}, (path) => path.endsWith("/_sandbox/castd/target/release/castd"))).toMatch(/\/_sandbox\/castd\/target\/release\/castd$/u);
        expect(castdBinary({}, () => false)).toBeUndefined();
    });
});

describe("castSessionOf", () => {
    test("a key that is already a media path's name is kept readable", () => {
        expect(castSessionOf("_own")).toBe("cast-_own");
    });

    test("an account's key becomes a valid name, distinct for each key", () => {
        const name = castSessionOf("someone@example.com");
        expect(name).toMatch(/^cast-someone_example_com-[0-9a-f]{8}$/u);
        expect(castSessionOf("someone@example.org")).not.toBe(name);
        expect(castSessionOf(`${"x".repeat(80)}@example.com`)).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    });
});

describe("castdArgs", () => {
    test("a kiosk's castd resizes the screen up to the display's size; a cropped one names its rectangle", () => {
        expect(castdArgs(SCREEN, "cast-_own", "/run/intentic/cast/cast-_own.sock", "/run/intentic/cast/key")).toEqual([
            "--session",
            "cast-_own",
            "--key-file",
            "/run/intentic/cast/key",
            "--display",
            ":99",
            "--socket",
            "/run/intentic/cast/cast-_own.sock",
            "--max-size",
            "3840x2400",
        ]);
        expect(castdArgs({ ...CROP, audio: { source: "x100.monitor", server: "unix:/run/intentic/cast/pulse.sock" } }, "cast-a", "/s", "/k")).toEqual([
            "--session",
            "cast-a",
            "--key-file",
            "/k",
            "--display",
            ":100",
            "--socket",
            "/s",
            "--crop",
            "1280,720,1280,880",
            "--audio-source",
            "x100.monitor",
        ]);
    });
});

describe("CastdProcess", () => {
    test("starts castd on its display, ready once it answers, and says so to whoever listens", async () => {
        const fake = fakeCastd();
        answering(fake);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        const started: number[] = [];
        castd.onStarted((generation) => started.push(generation));
        expect(await castd.ready()).toBe(true);
        expect(fake.children).toHaveLength(1);
        expect(fake.children[0]?.env["DISPLAY"]).toBe(":99");
        expect(fake.pidFiles.get("/fake/cast/cast-_own.pid")).toBe(fake.children[0]?.pid);
        expect(castd.socket).toBe("/fake/cast/cast-_own.sock");
        expect(started).toEqual([1]);
        castd.stop();
    });

    test("a castd that dies on its own is started again, and the next generation announced", async () => {
        const fake = fakeCastd();
        answering(fake);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        const started: number[] = [];
        castd.onStarted((generation) => started.push(generation));
        await castd.ready();
        fake.children[0]?.exit(101);
        expect(await pollUntil(() => started.length === 2, SETTLED)).toBe(true);
        expect(fake.children).toHaveLength(2);
        expect(started).toEqual([1, 2]);
        expect(fake.logs).toContain("castd: exited unasked; starting it again");
        castd.stop();
    });

    test("one whose display is gone is left down", async () => {
        const fake = fakeCastd({ displayUp: async () => false });
        answering(fake);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        await castd.ready();
        fake.children[0]?.exit(1);
        expect(await pollUntil(() => fake.logs.includes("castd: its display is gone; not starting it again"), SETTLED)).toBe(true);
        expect(fake.children).toHaveLength(1);
        castd.stop();
    });

    test("one that never answers within the start budget is killed, which counts as a death", async () => {
        const fake = fakeCastd();
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        expect(await castd.ready()).toBe(false);
        expect(fake.children[0]?.signals).toEqual(["SIGKILL"]);
        // Answering now: the start after the backoff is the one that holds.
        answering(fake);
        expect(await pollUntil(() => fake.children.length === 2, SETTLED)).toBe(true);
        expect(await castd.ready()).toBe(true);
        castd.stop();
    });

    test("an earlier daemon's castd, still serving framed as asked, is adopted rather than started again", async () => {
        const fake = fakeCastd();
        answering(fake);
        fake.live.set(777, "cast-_own");
        fake.pidFiles.set("/fake/cast/cast-_own.pid", 777);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        expect(await castd.ready()).toBe(true);
        expect(fake.children).toHaveLength(0);
        castd.stop();
        expect(fake.kills).toEqual([{ pid: 777, signal: "SIGTERM" }]);
        expect(fake.pidFiles.has("/fake/cast/cast-_own.pid")).toBe(false);
    });

    test("one framed the other way is ended and a fresh one started", async () => {
        const fake = fakeCastd();
        answering(fake, GEOMETRY_SCREEN);
        fake.live.set(778, castSessionOf(CROP.key));
        fake.pidFiles.set(`/fake/cast/${castSessionOf(CROP.key)}.pid`, 778);
        const castd = new CastdProcess(CROP, castSessionOf(CROP.key), fake.deps);
        expect(await castd.ready()).toBe(true);
        expect(fake.kills[0]).toEqual({ pid: 778, signal: "SIGTERM" });
        expect(fake.children).toHaveLength(1);
        expect(fake.children[0]?.args).toContain("--crop");
        castd.stop();
    });

    test("a stopped castd is ended and never started again", async () => {
        const fake = fakeCastd();
        answering(fake);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        await castd.ready();
        const pid = fake.children[0]?.pid ?? -1;
        castd.stop();
        expect(fake.kills).toEqual([{ pid, signal: "SIGTERM" }]);
        // The exit the SIGTERM caused is no death to restart from.
        expect(await pollUntil(() => fake.children.length > 1, { intervalMs: 50, timeoutMs: 1_500 })).toBe(false);
        expect(fake.logs).toContain("castd: stopped");
    });

    test("a crop moves live where castd can, and castd is started again on the new rectangle where it cannot", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 1280, y: 720, w: 1280, h: 880 }, resizable: false });
        fake.answers.set("POST /crop", castAnswer(200, `{"ok":true}`));
        const castd = new CastdProcess(CROP, castSessionOf(CROP.key), fake.deps);
        await castd.ready();
        await castd.moveCrop({ x: 1000, y: 600, width: 1560, height: 1000 });
        expect(fake.asked.at(-1)).toEqual({ method: "POST", path: "/crop?x=1000&y=600&w=1560&h=1000" });
        expect(fake.children).toHaveLength(1);
        fake.answers.delete("POST /crop");
        await castd.moveCrop({ x: 0, y: 0, width: 800, height: 600 });
        expect(fake.children).toHaveLength(2);
        expect(fake.children[1]?.args).toContain("0,0,800,600");
        castd.stop();
    });

    test("two moves at once where castd cannot move live leave one castd, on the latest rectangle, and no orphan beside it", async () => {
        const fake = fakeCastd();
        answering(fake, { ...GEOMETRY_SCREEN, crop: { x: 1280, y: 720, w: 1280, h: 880 }, resizable: false });
        const castd = new CastdProcess(CROP, castSessionOf(CROP.key), fake.deps);
        await castd.ready();
        await Promise.all([castd.moveCrop({ x: 0, y: 0, width: 800, height: 600 }), castd.moveCrop({ x: 10, y: 10, width: 900, height: 700 })]);
        const running = fake.children.filter((child) => fake.live.has(child.pid));
        expect(running).toHaveLength(1);
        expect(running[0]?.args).toContain("10,10,900,700");
        castd.stop();
    });

    test("a castd serving its whole screen is never made a crop by a move, which would start it again under its viewers", async () => {
        const fake = fakeCastd();
        answering(fake);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        await castd.ready();
        await castd.moveCrop({ x: 0, y: 0, width: 800, height: 600 });
        expect(castd.framing()).toEqual({ kind: "screen" });
        expect(fake.children).toHaveLength(1);
        castd.stop();
    });

    test("an earlier daemon's castd that answers only after the stop is ended, not adopted and left running", async () => {
        const fake = fakeCastd();
        answering(fake);
        fake.live.set(779, "cast-_own");
        fake.pidFiles.set("/fake/cast/cast-_own.pid", 779);
        const castd = new CastdProcess(SCREEN, "cast-_own", fake.deps);
        // Its display went while the health check was out.
        castd.stop();
        await castd.ready();
        expect(fake.live.has(779)).toBe(false);
        expect(fake.children).toHaveLength(0);
    });
});

describe("castControl", () => {
    test("a pin, an unpin and a crop wait past castd's own 3 s for the new size, so a slow resize is not read as no castd", async () => {
        const timeouts = new Map<string, number | undefined>();
        const control = castControl("/s", async (_socket, method, path, timeoutMs) => {
            timeouts.set(`${method} ${path.split("?")[0] ?? ""}`, timeoutMs);
            return castAnswer(200, `{"ok":true}`);
        });
        await control.pin({ width: 390, height: 844, scale: 3 });
        await control.unpin();
        await control.crop({ x: 0, y: 0, width: 800, height: 600 });
        for (const route of ["POST /pin", "POST /unpin", "POST /crop"]) {
            expect(timeouts.get(route)).toBeGreaterThan(3_000);
        }
    });
});

describe("dropCastdViewers", () => {
    test("asks every running castd to end its viewers' sockets, and a castd started after it refuses the older tokens too", async () => {
        const fake = fakeCastd();
        answering(fake);
        fake.answers.set("POST /viewers/drop", castAnswer(200, `{"ok":true,"dropped":2}`));
        configureCastd({ ...fake.deps, droppedAt: castdDroppedAt });
        const own = ensureCastd({ ...SCREEN, key: "drop-own" });
        const agent = ensureCastd({ ...CROP, key: "drop-agent" });
        await Promise.all([own?.ready(), agent?.ready()]);
        expect(await dropCastdViewers("access revoked", 1_800_000_000_000)).toBe(4);
        expect(fake.asked.filter((asked) => asked.path === "/viewers/drop?reason=access+revoked")).toHaveLength(2);
        stopCastd("drop-own");
        // Started after the drop: it refuses what was handed out before it, as the running ones now do.
        const after = ensureCastd({ ...SCREEN, key: "drop-own" });
        await after?.ready();
        expect(fake.children.at(-1)?.args).toEqual(expect.arrayContaining(["--not-before", "1800000000000"]));
        stopCastd("drop-own");
        stopCastd("drop-agent");
    });

    test("a castd is started with where it writes recordings and the last drop it must still honour", () => {
        expect(castdArgs(SCREEN, "cast-_own", "/s", "/k", { recordDir: "/w/.intentic/local/browser/recordings", notBefore: 1_800_000_000_000.4 })).toEqual(
            expect.arrayContaining(["--record-dir", "/w/.intentic/local/browser/recordings", "--not-before", "1800000000000"]),
        );
        expect(castdArgs(SCREEN, "cast-_own", "/s", "/k", { notBefore: 0 })).not.toContain("--not-before");
    });
});

describe("ensureCastd", () => {
    test("a key whose display changed gets a castd on its new display, never the one serving the old number", async () => {
        const fake = fakeCastd();
        answering(fake);
        configureCastd(fake.deps);
        const spec: CastdSpec = { ...SCREEN, key: "display-moved" };
        const first = ensureCastd(spec);
        await first?.ready();
        const second = ensureCastd({ ...spec, display: ":120" });
        expect(second).not.toBe(first);
        await second?.ready();
        expect(fake.children.at(-1)?.args).toContain(":120");
        expect(fake.live.has(fake.children[0]?.pid ?? -1)).toBe(false);
        stopCastd(spec.key);
    });
});
