import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { serve, type ServerType } from "@hono/node-server";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import type { RawRouteKey } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import type { TxtAnswer } from "@intentic/sandbox-contract/s2s";
import { type Handler, Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { serveRawRoutes } from "../http/raw-route-server.js";
import { actionRefusal } from "../guard/outbound-guard.js";
import type { AskerDeps } from "./askers.js";
import { attestationsRoutesOf } from "./attestations/attestations.routes.js";
import { callsRoutesOf } from "./calls/calls.routes.js";
import { contactsRoutesOf } from "./contacts/contacts.routes.js";
import type { S2sHeard } from "./heard.js";
import { identityRoutesOf } from "./identity/identity.routes.js";
import { createS2sIdentity, type S2sIdentity } from "./identity/s2s-identity.js";
import { messagesRoutesOf } from "./messages/messages.routes.js";
import type { S2sFetch } from "./messages/outbox.js";
import { S2S_SEND_ACTION } from "./messages/send-guard.js";
import { createS2s, type S2s } from "./s2s-service.js";
import { hostUrl, identityFetcher } from "./s2s-wiring.js";

// A WHOLE SANDBOX'S S2S SIDE ON A PORT, for suites that make two or three of them talk over HTTP as two daemons do: its
// identity (real keys on disk), its contacts, admission, inbox and outbox, its calls door (whose methods a suite
// serves itself) and its attestations, served on 127.0.0.1 under the very route tables the daemon serves. A request names its person with `x-test-as` (the bearer middleware's place); the roster is
// the suite's. Every outgoing request goes through `intercept` first, so a suite can stand in for the edge (a 503 while
// a sandbox wakes) or watch the `?wake=` an attempt carried. The identity can be swapped for a fresh one (`loseKeys`), as
// a sandbox whose volume was lost. Integration suites only: it opens a port and temp directories.

// What a request carries: anything JSON.stringify takes, typed by the schema each suite builds it from.
export type RequestBody = Parameters<typeof JSON.stringify>[0];

const quietLogger = { info: () => undefined, warn: () => undefined };

export interface S2sDaemon {
    readonly name: string;
    readonly host: string;
    readonly s2s: S2s;
    readonly identity: () => S2sIdentity;
    readonly heard: S2sHeard[];
    // Every outgoing request's URL, in order.
    readonly sent: string[];
    // Answers an outgoing request instead of the network when it returns a response.
    intercept: ((url: string) => Response | undefined) | undefined;
    // The owner's action rules an agent's send is held to.
    rules: Record<string, AdmissionRule>;
    // A request to this daemon as the person named (or nobody), JSON both ways.
    readonly http: (as: string | undefined, method: string, path: string, body?: RequestBody, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
    // Its own temp tree: `auth/`, `history/`, `workspace/`.
    readonly root: string;
    // The roster's owner.
    readonly owner: string;
    // A brand-new identity in place of the old, with no vouch: what losing the volume with the keys looks like.
    readonly loseKeys: () => void;
    readonly close: () => Promise<void>;
}

export interface S2sDaemonOptions {
    readonly roster: Readonly<Record<string, Caller>>;
    // The conversations a proven turn acts for, by id; empty acts for the owner.
    readonly people?: Readonly<Record<string, readonly string[]>>;
    // The identity document's sandbox id; absent, `<name>-sandbox`.
    readonly sandbox?: string;
    // More routes served beside the contacts' and the messages', built over this daemon's s2s.
    readonly routes?: (s2s: S2s) => Partial<Readonly<Record<RawRouteKey, Handler<AppEnv>>>>;
    // The DNS this daemon's TXT lookups see, both its own domain checks and the addresses it resolves (one fake shared by
    // the suite's daemons, as one internet is); absent, no name has a record.
    readonly txt?: (name: string) => Promise<TxtAnswer>;
}

const listening = async (app: Hono<AppEnv>): Promise<{ server: ServerType; port: number }> => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    // SAFETY: a server listening on a TCP host and port answers its address as AddressInfo, never as a pipe's name.
    return { server, port: (server.address() as AddressInfo).port };
};

const askersFor = (options: S2sDaemonOptions): AskerDeps => {
    const owner = Object.values(options.roster).find((caller) => caller.tier === "owner")?.email;
    return {
        peopleOf: (conversationId) => options.people?.[conversationId] ?? [],
        ownerEmail: async () => owner,
        tierOf: async (email) => options.roster[email.toLowerCase()]?.tier,
    };
};

// What a suite steers from outside: the requests going out, and the owner's action rules.
interface Hooks {
    intercept: ((url: string) => Response | undefined) | undefined;
    rules: Record<string, AdmissionRule>;
    readonly sent: string[];
}

const request =
    (host: string) =>
    async (as: string | undefined, method: string, path: string, body?: RequestBody, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
        const named = new Headers({ "content-type": "application/json", ...headers });
        if (as !== undefined) {
            named.set("x-test-as", as);
        }
        const init: RequestInit = { method, headers: named };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }
        const response = await fetch(`http://${host}${path}`, init);
        const text = await response.text();
        return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
    };

// Where taking files writes: the suite's own temp workspace, every folder open.
const takeInto = (root: string) => ({
    workspace: unstubbed<Services["workspace"]>("workspace", { root }),
    areas: unstubbed<Services["areas"]>("areas", { list: async () => [] }),
    files: unstubbed<Services["files"]>("files", {
        write: async (path: string, bytes: string | Uint8Array) => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, bytes);
        },
    }),
});

export const s2sDaemon = async (name: string, options: S2sDaemonOptions): Promise<S2sDaemon> => {
    const root = mkdtempSync(join(tmpdir(), `s2s-${name}-`));
    mkdirSync(join(root, "workspace"), { recursive: true });
    const app = new Hono<AppEnv>();
    const { server, port } = await listening(app);
    const host = `127.0.0.1:${port}`;
    let keysAt = 0;
    const identityFor = (): S2sIdentity =>
        createS2sIdentity({
            keysPath: join(root, "auth", `sandbox-identity-${keysAt}.json`),
            domainsPath: join(root, "history", "s2s", "identity-domains.json"),
            attestationsPath: join(root, "history", "s2s", "identity-attestations.json"),
            self: () => ({ sandbox: options.sandbox ?? `${name}-sandbox`, name, host }),
            resolveTxt: options.txt ?? (async () => ({ kind: "missing" })),
            now: Date.now,
        });
    let identity = identityFor();
    // Told of a rotation as the daemon's own boot wires it (s2s-slice.ts startS2s): every contact hears of the new key.
    const announced = (): void => {
        identity.onRotated(() => {
            void s2s.announceRotation();
        });
    };
    const hooks: Hooks = { intercept: undefined, rules: {}, sent: [] };
    const outgoing: S2sFetch = async (url, init) => {
        hooks.sent.push(url);
        return hooks.intercept?.(url) ?? fetch(url, init);
    };
    const s2s = createS2s({
        historyRoot: join(root, "history"),
        authRoot: join(root, "auth"),
        identity: () => identity,
        addressIo: { resolveTxt: options.txt ?? (async () => ({ kind: "missing" })), fetchIdentity: identityFetcher(outgoing, hostUrl) },
        urlOf: hostUrl,
        fetch: outgoing,
        // The private-hosts switch, on: the suite's daemons are 127.0.0.1 ports.
        hostProblem: () => undefined,
        roster: async () => ({ callerOf: (email) => options.roster[email.toLowerCase()] }),
        now: Date.now,
        logger: quietLogger,
    });
    announced();
    const heard: S2sHeard[] = [];
    s2s.onHeard(async (event) => {
        heard.push(event);
    });
    app.use(async (c, next) => {
        const caller = options.roster[c.req.header("x-test-as") ?? ""];
        if (caller !== undefined) {
            c.set("identity", { ...caller, methods: ["google"] });
        }
        await next();
    });
    const askers = askersFor(options);
    serveRawRoutes(app, {
        // The document of whichever identity is current, as a daemon serves its own, and the attestations it carries.
        "GET /s2s/identity": async (c) => c.json(await identity.document()),
        // The identity's own attestation routes, over whichever identity is current when asked.
        "GET /s2s/me/attestations": async (c) => identityRoutesOf(identity)["GET /s2s/me/attestations"](c),
        "DELETE /s2s/me/attestations/{id}": async (c) => identityRoutesOf(identity)["DELETE /s2s/me/attestations/{id}"](c),
        ...attestationsRoutesOf(s2s, () => identity),
        ...contactsRoutesOf(s2s, askers),
        ...callsRoutesOf(s2s.calls.door),
        ...messagesRoutesOf(s2s, {
            askers,
            guard: { refusal: async () => actionRefusal(hooks.rules, S2S_SEND_ACTION), record: () => undefined },
            take: takeInto(join(root, "workspace")),
        }),
        ...options.routes?.(s2s),
    });
    return Object.assign(hooks, {
        name,
        owner: Object.values(options.roster).find((caller) => caller.tier === "owner")?.email ?? "",
        host,
        root,
        s2s,
        identity: () => identity,
        heard,
        http: request(host),
        loseKeys: () => {
            keysAt += 1;
            identity = identityFor();
            announced();
        },
        close: async () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                // A kept-alive connection would hold the close open until it idles out.
                if ("closeAllConnections" in server) {
                    server.closeAllConnections();
                }
            }),
    });
};

/** Waits for a condition the daemons reach on their own (an outbox attempt landing), failing with what it waited for. */
export const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > deadline) {
            throw new Error(`never: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};
