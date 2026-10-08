import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { promisify } from "node:util";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Services } from "../composition.js";
import { onRuntimeChange } from "../seams/runtime-feed.js";
import { agentDesktop, desktopAvailable, desktopState, ownerHandedBack } from "./agent-desktop.js";
import { createDesktopViewRoute } from "./desktop-view.js";

/* One window of the sandbox's desktop over the real socket: a real Xvfb with openbox on it, an xmessage to show, ffmpeg
   grabbing it and xdotool for the hands. What it pins is what no unit can: that the picture is the window's own inside,
   that a pointer event in the picture's pixels lands on the window wherever it has moved, that a move or a resize is a
   fresh `ready`, and that a closed window says `gone` and closes the socket. */

const exec = promisify(execFile);

const x11 = requires(
    desktopAvailable() && ["/usr/bin/xmessage", "/usr/bin/wmctrl", "/usr/bin/xwininfo", "/usr/bin/xprop"].every((path) => existsSync(path)),
    "the browser pack's Xvfb, ffmpeg and xdotool, with openbox, wmctrl, xwininfo, xprop and xmessage",
    { absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it" },
);

// Polls for a condition rather than sleeping a guess; generous but finite, so a regression fails rather than hangs.
const settle = async (until: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
    for (let waited = 0; waited < ms && !(await until()); waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
};

// What the view says, as far as these tests read it; anything else it says is kept but not looked at.
const SaidSchema = z.looseObject({ type: z.string(), width: z.number().optional(), height: z.number().optional() });

interface Wire {
    readonly json: z.infer<typeof SaidSchema>[];
    closed?: number;
}

const readies = (wire: Wire) => wire.json.filter((message) => message.type === "ready");

const stand = async () => {
    // No auth: the loopback daemon, which takes no ticket.
    const services = unstubbed<Services>("services", { logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }), auth: undefined });
    const app = new Hono().get("/system/desktop-view", createDesktopViewRoute(services));
    // SAFETY: ws's own server is the one hono's adapter is written against; the types differ only in that ws spells
    // `options.noServer` as possibly undefined, which exactOptionalPropertyTypes reads as another type.
    const sockets = new WebSocketServer({ noServer: true }) as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const open = async (query: string): Promise<{ socket: WebSocket; wire: Wire }> => {
        const wire: Wire = { json: [] };
        const socket = new WebSocket(`ws://127.0.0.1:${port}/system/desktop-view?${query}`);
        socket.on("message", (data, binary) => {
            if (!binary) {
                wire.json.push(SaidSchema.parse(JSON.parse(String(data))));
            }
        });
        socket.on("close", (code) => {
            wire.closed = code;
        });
        await once(socket, "open");
        return { socket, wire };
    };
    return { open, close: () => server.close() };
};

afterAll(() => {
    ownerHandedBack();
});

describe.skipIf(!x11.runs)(x11.title("one window of the sandbox's desktop, over the view's socket"), () => {
    test(
        "is the window's inside, followed as it moves and resizes, aimed in its own pixels, and gone once it closes",
        async () => {
            const desk = await agentDesktop();
            const env = { ...process.env, DISPLAY: desk.display.name };
            const title = `desktop-view-${process.pid}`;
            const program = spawn("xmessage", ["-title", title, "-geometry", "300x120+100+150", "a window to show alone"], { env, stdio: "ignore" });
            let over: ReturnType<typeof spawn> | undefined;
            const server = await stand();
            try {
                // The list the editor reads names it, with the id the view takes.
                let id: string | undefined;
                await settle(async () => {
                    id = (await desktopState()).list?.find((window) => window.title === title)?.id;
                    return id !== undefined;
                });
                if (id === undefined) {
                    throw new Error(`the desktop never listed ${title}`);
                }
                const window = id;
                expect((await desktopState()).list?.find((entry) => entry.id === window)).toMatchObject({ app: "Xmessage", title });
                const place = async () => {
                    const { stdout } = await exec("xwininfo", ["-id", window], { env });
                    const field = (name: string) => Number(new RegExp(`${name}:\\s*(-?\\d+)`).exec(stdout)?.[1]);
                    return { x: field("Absolute upper-left X"), y: field("Absolute upper-left Y"), width: field("Width"), height: field("Height") };
                };

                over = spawn("xmessage", ["-title", `${title}-over`, "-geometry", "200x80+600+150", "another window"], { env, stdio: "ignore" });
                const { socket, wire } = await server.open(`window=${window}`);
                await settle(() => readies(wire).length > 0);
                const first = await place();
                expect(readies(wire)[0]).toMatchObject({ kind: "video", width: first.width - (first.width % 2), height: first.height - (first.height % 2) });

                // Taking over raises the window and gives it the keyboard, away from a window opened over it since.
                const activeNow = async () => Number((await exec("xdotool", ["getactivewindow"], { env })).stdout.trim());
                await settle(async () => {
                    const listed = (await desktopState()).list?.find((entry) => entry.title === `${title}-over`);
                    return listed !== undefined && (await activeNow()) === Number(listed.id);
                });
                expect(await activeNow()).not.toBe(Number(window));
                socket.send(JSON.stringify({ type: "control", driving: true }));
                await settle(async () => (await activeNow()) === Number(window));
                expect(await activeNow()).toBe(Number(window));

                // A pointer event in the picture's pixels lands at the window's place plus that point.
                const pointer = async () => (await exec("xdotool", ["getmouselocation", "--shell"], { env })).stdout;
                socket.send(JSON.stringify({ type: "mouse", action: "move", x: 7, y: 9 }));
                await settle(async () => (await pointer()).includes(`X=${first.x + 7}\nY=${first.y + 9}`));
                expect(await pointer()).toContain(`X=${first.x + 7}\nY=${first.y + 9}`);

                // Moved: a fresh stream at the same size, and the next pointer event follows the window there.
                await exec("xdotool", ["windowmove", window, "400", "300"], { env });
                await settle(() => readies(wire).length > 1);
                expect(readies(wire).length).toBeGreaterThan(1);
                const moved = await place();
                expect(moved.x).not.toBe(first.x);
                socket.send(JSON.stringify({ type: "mouse", action: "move", x: 3, y: 4 }));
                await settle(async () => (await pointer()).includes(`X=${moved.x + 3}\nY=${moved.y + 4}`));
                expect(await pointer()).toContain(`X=${moved.x + 3}\nY=${moved.y + 4}`);

                // Resized: the next `ready` is the new size.
                const before = readies(wire).length;
                await exec("xdotool", ["windowsize", window, "240", "90"], { env });
                await settle(() => readies(wire).length > before);
                const resized = await place();
                expect(readies(wire).at(-1)).toMatchObject({ width: resized.width - (resized.width % 2), height: resized.height - (resized.height % 2) });
                expect(resized.width).toBe(240);

                // Retitled: no property of the root changes, so only the slow look an open view keeps up says so.
                const heard: number[] = [];
                const stopHearing = onRuntimeChange((domains) => {
                    if (domains.includes("desktop")) {
                        heard.push(Date.now());
                    }
                });
                try {
                    await new Promise((resolve) => setTimeout(resolve, 1_500));
                    const renamedAt = Date.now();
                    await exec("xdotool", ["set_window", "--name", `${title}-renamed`, window], { env });
                    await settle(() => heard.some((at) => at >= renamedAt), 10_000);
                    expect(heard.some((at) => at >= renamedAt)).toBe(true);
                    expect((await desktopState()).list?.find((entry) => entry.id === window)?.title).toBe(`${title}-renamed`);
                } finally {
                    stopHearing();
                }

                // Closed: `gone`, then the socket closes as finished.
                program.kill();
                await settle(() => wire.closed !== undefined);
                expect(wire.json.at(-1)).toEqual({ type: "gone" });
                expect(wire.closed).toBe(1000);
            } finally {
                program.kill();
                over?.kill();
                server.close();
            }
        },
        { timeout: 60_000 },
    );

    test("a view asked for a window that is not there says so and closes", async () => {
        await agentDesktop();
        const server = await stand();
        try {
            const missing = await server.open("window=0x7ffffff0");
            await settle(() => missing.wire.closed !== undefined);
            expect(missing.wire.json.at(-1)).toEqual({ type: "gone" });
            expect(missing.wire.closed).toBe(1000);
            const malformed = await server.open("window=-root");
            await settle(() => malformed.wire.closed !== undefined);
            expect(malformed.wire.json).toEqual([{ type: "gone" }]);
            expect(malformed.wire.closed).toBe(1000);
        } finally {
            server.close();
        }
    });
});
