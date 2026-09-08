import { expect, test } from "vitest";
import { identifyPort, type PortAttribution } from "./port-identity.js";
import type { ListeningPort } from "./port-scan.js";

// What each row of the Ports view says, not the port numbers; each case is a listener a stock sandbox actually has.

const attribution = (
    extensions: Record<string, { extensionId: string; processName: string }> = {},
    servicePorts: Record<number, string> = {},
): PortAttribution => ({
    workspaceRoot: "/work",
    extensionProcesses: new Map(Object.entries(extensions)),
    servicePorts: new Map(Object.entries(servicePorts).map(([port, key]) => [Number(port), key])),
});

const listener = (over: Partial<ListeningPort>): ListeningPort => ({ port: 3000, host: "127.0.0.1", forwardable: true, ...over });

test("the sandbox's own processes are named, not left as argv, and file under system wherever they run", () => {
    // The daemon's own cwd is the workspace root, which could misfile it as a user's own port.
    expect(
        identifyPort(
            listener({ command: "node --report-on-fatalerror --report-directory=/history/logs /opt/sandbox/dist/main.js", cwd: "/work" }),
            attribution(),
        ),
    ).toEqual({
        title: "Sandbox service",
        purpose: "The sandbox's own service, this app, your agents and the CLI all talk to it.",
        origin: "sandbox",
        kind: "system",
    });
    // Must beat the catch-all above it: also a script under the install dir.
    expect(
        identifyPort(
            listener({ command: "/usr/local/bin/node /opt/sandbox/dist/extensions/backend/backend-host-main.js", cwd: "/work" }),
            attribution(),
        ).title,
    ).toBe("Extension services");
    expect(identifyPort(listener({ command: "cli-proxy-api --config /history/translator/config.yaml", cwd: "/work" }), attribution()).title).toBe(
        "Model request router",
    );
    expect(identifyPort(listener({ command: "opencode serve --hostname=127.0.0.1 --port=4096", cwd: "/work" }), attribution()).kind).toBe("system");
    // No process in this namespace owns the socket; named by the scan itself.
    const dns = identifyPort(listener({ command: "Docker embedded DNS" }), attribution());
    expect(dns.title).not.toBe("Sandbox service");
    expect(dns.kind).toBe("system");
});

test("a user's own checkout outranks the sandbox-binary table", () => {
    const repo = "myrepo";
    const own = identifyPort(listener({ command: "opencode serve --port=4096", cwd: `/work/${repo}` }), attribution());
    expect(own.kind).toBe("workspace");
    expect(own.purpose).toContain(repo);
});

test("a published container port says which port answers inside the container", () => {
    expect(
        identifyPort(
            listener({
                port: 5440,
                command:
                    "/usr/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port 5440 -container-ip 172.18.0.2 -container-port 5432 -use-listen-fd",
                cwd: "/work",
                session: "panel-docker",
            }),
            attribution(),
        ),
    ).toEqual({
        title: "Container port",
        purpose: "A container running in this sandbox publishes its port 5432 here.",
        origin: "container",
        // The container is the user's to preview; the sandbox only provides the plumbing.
        kind: "workspace",
    });
});

test("an extension's background service is named after the extension, not after its command", () => {
    // Supervised services descend from the daemon, not a tmux pane; recognized by port, not session.
    expect(
        identifyPort(
            listener({ port: 40085, command: "node dist/gateway.js", cwd: "/opt/extensions/discord" }),
            attribution({ "ext-intentic-discord-gateway": { extensionId: "intentic.discord", processName: "gateway" } }, { 40085: "ext-intentic-discord-gateway" }),
        ),
    ).toEqual({
        title: "Discord gateway",
        purpose: "A background service the intentic.discord extension asked the sandbox to run.",
        origin: "extension",
        kind: "system",
    });
    // An extension index entry that's gone (uninstalled mid-scan) still reads as what it is.
    expect(identifyPort(listener({ port: 40086, command: "node dist/gateway.js" }), attribution({}, { 40086: "ext-gone-thing" })).title).toBe(
        "Extension service",
    );
});

test("a dev server is named by its tool and attributed to the terminal it was started in", () => {
    expect(
        identifyPort(
            listener({
                port: 5173,
                command: "node /work/intentic/_editor/web/node_modules/.bin/vite",
                cwd: "/work/intentic/_editor/web",
                session: "web-2",
            }),
            attribution(),
        ),
    ).toEqual({
        title: "Vite dev server",
        purpose: "Started in one of your terminals in intentic/_editor/web.",
        origin: "terminal",
        kind: "workspace",
    });
    // An agent's terminal is the other common owner; the user did not start this one.
    expect(identifyPort(listener({ command: "python -m http.server 8000", cwd: "/work", session: "agent-1a2b3c4d" }), attribution())).toEqual({
        title: "Static file server",
        purpose: "Started by an agent in its terminal.",
        origin: "agent",
        kind: "workspace",
    });
    // A repo's panel names the repo it serves; `--` in a panel key is the nested repo's slash.
    expect(identifyPort(listener({ command: "node .bin/astro dev", cwd: "/work/site", session: "panel-site" }), attribution()).purpose).toBe(
        "The dev server this app runs for site.",
    );
});

test("a listener nothing explains says so rather than guessing", () => {
    expect(identifyPort(listener({}), attribution())).toEqual({
        title: "Unclaimed port",
        purpose: "Something is listening here that no process in this sandbox owns, usually container plumbing.",
        origin: "unknown",
        kind: "system",
    });
    // An unknown binary keeps its own name: still a name, just a less friendly one.
    expect(identifyPort(listener({ command: "/usr/local/bin/weird-thing --serve", cwd: "/srv" }), attribution())).toEqual({
        title: "weird-thing",
        purpose: "Nothing in the sandbox claims this one, it answers from outside the container.",
        origin: "unknown",
        kind: "system",
    });
});
