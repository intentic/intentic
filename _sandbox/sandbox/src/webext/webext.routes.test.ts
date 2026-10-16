import { WebExtSecretAnswerSchema, type WebExtSecretRequest } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { z } from "zod";
import type { Services } from "../composition.js";
import type { Presented } from "../peers/enrollment.js";
import { createSecretTickets, type OwnerBrowserTypeArgs } from "./secret-tickets.js";
import { createWebExtSecretRoute } from "./webext.routes.js";

// POST /system/webext/secret, the one door a stored secret leaves this sandbox through for the owner's own browser: on
// the browser's own enrollment token, which says which browser is asking, for a ticket the daemon handed that browser.
// Played end to end: the turn's typing mints the ticket, the browser (as the test plays it) presents it here over HTTP.

const PAGE = "https://grafana.example.com/login";
const VALUE = "s3cret-value-never-shown";

// Two paired browsers, each by its own token.
const TOKENS = new Map<string, Presented>([
    ["iwx_chrome", { kind: "enrolled", id: "chrome", card: "chrome" }],
    ["iwx_brave", { kind: "enrolled", id: "brave", card: "brave" }],
]);

// Who presents a ticket at the door, and with what.
interface Presenter {
    readonly token: string;
    readonly request: (ticket: string) => WebExtSecretRequest;
}

const CallSchema = z.object({ params: z.object({ arguments: z.object({ ticket: z.string() }) }) });

const stage = () => {
    const logged: string[] = [];
    const replies: { status: number; body: unknown }[] = [];
    const app = new Hono();
    // Who presents the ticket, and with what: the browser of the test's choosing.
    let presenting: Presenter = { token: "iwx_chrome", request: (ticket) => ({ ticket, url: PAGE, field: "password" }) };
    const post = async (token: string, body: string) => {
        const response = await app.request("/system/webext/secret", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body,
        });
        const reply = { status: response.status, body: await response.json() };
        replies.push(reply);
        return reply;
    };
    const secretTickets = createSecretTickets({
        hub: {
            online: () => true,
            offline: (id) => `"${id}" is away`,
            knownTools: () => ({ tools: [{ name: "type_ticket" }] }),
            // The extension's half: present the ticket at the door, and say what came of it.
            mcp: async (_id, payload) => {
                const { ticket } = CallSchema.parse(payload).params.arguments;
                const reply = await post(presenting.token, JSON.stringify(presenting.request(ticket)));
                const answer = WebExtSecretAnswerSchema.parse(reply.body);
                return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: answer.ok ? "Typed." : answer.message }], isError: !answer.ok } };
            },
        },
        callTimeoutMs: 60_000,
    });
    app.post(
        "/system/webext/secret",
        createWebExtSecretRoute({
            webexts: unstubbed<Services["webexts"]>("webexts", { verify: async (token) => TOKENS.get(token) ?? { kind: "unknown" } }),
            secretTickets,
            logger: unstubbed<Services["logger"]>("logger", {
                info: (...args: unknown[]) => {
                    logged.push(JSON.stringify(args));
                },
            }),
        }),
    );
    return {
        logged,
        replies,
        post,
        present: (next: Presenter) => {
            presenting = next;
        },
        type: async (redeem: OwnerBrowserTypeArgs["redeem"] = async () => ({ value: VALUE })) =>
            await secretTickets.typeIn({ card: "chrome", secret: "GRAFANA_ADMIN_PASSWORD", redeem }),
    };
};

test("the browser collects the value on its own token, and the log names the secret and the ticket's tag, never either itself", async () => {
    const staged = stage();
    expect(await staged.type()).toEqual({ ok: true, host: "grafana.example.com", field: "password" });
    expect(staged.replies).toEqual([{ status: 200, body: { ok: true, value: VALUE } }]);
    expect(staged.logged).toHaveLength(1);
    const [line = ""] = staged.logged;
    expect(line).toContain(`"secret":"GRAFANA_ADMIN_PASSWORD"`);
    expect(line).toContain(`"host":"grafana.example.com"`);
    expect(line).toMatch(/"ticket":"[0-9a-f]{8}"/u);
    expect(line).not.toContain(VALUE);
});

test("a ticket presented on another browser's token is refused with its status, and the turn reads why", async () => {
    const staged = stage();
    staged.present({ token: "iwx_brave", request: (ticket) => ({ ticket, url: PAGE, field: "password" }) });
    expect(await staged.type()).toEqual({ ok: false, refusal: "That ticket was issued to another browser." });
    expect(staged.replies).toEqual([{ status: 403, body: { ok: false, message: "That ticket was issued to another browser." } }]);
    expect(staged.logged.join("\n")).not.toContain(VALUE);
});

test("the guard's refusal answers 403 with its sentence, and the value is in no reply and no log line", async () => {
    const staged = stage();
    const typed = await staged.type(async () => ({ refusal: "GRAFANA_ADMIN_PASSWORD may only be typed on grafana.internal." }));
    expect(typed).toEqual({ ok: false, refusal: "GRAFANA_ADMIN_PASSWORD may only be typed on grafana.internal." });
    expect(staged.replies).toEqual([{ status: 403, body: { ok: false, message: "GRAFANA_ADMIN_PASSWORD may only be typed on grafana.internal." } }]);
});

test("a token no browser holds is turned away before any ticket is looked at, and an unreadable body is refused", async () => {
    const staged = stage();
    expect(await staged.post("iwx_nobody", JSON.stringify({ ticket: "t", url: PAGE, field: "password" }))).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await staged.post("iwx_chrome", "not json")).toEqual({ status: 400, body: { ok: false, message: "That request is not one this sandbox can read." } });
    expect(await staged.post("iwx_chrome", JSON.stringify({ ticket: "t", url: PAGE, field: "hidden" }))).toEqual({
        status: 400,
        body: { ok: false, message: "That request is not one this sandbox can read." },
    });
    expect(await staged.post("iwx_chrome", JSON.stringify({ ticket: "guessed", url: PAGE, field: "text" }))).toEqual({
        status: 404,
        body: { ok: false, message: "That ticket is not one this sandbox is waiting on: it was never issued, or the call it was for has ended." },
    });
});
