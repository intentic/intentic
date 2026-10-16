import { z } from "zod";
import { createSecretTickets, type SecretTicketDesk, type TicketAnswer, type TicketPage, type TicketRedemption } from "./secret-tickets.js";
import type { WebExtHub } from "./webext-peer.js";

// A secret typed into the owner's own browser: the daemon hands the browser a ticket, the browser presents it at its
// door with the page it is about to type into, and only that answer carries the value. What is held to here: the
// browser is told nothing but the ticket; a ticket is good once, for a minute, for the browser it was minted for; the
// guard's refusal is the one the agent reads; and once the call is over no ticket of it is left to present.

const PAGE = "https://grafana.example.com/login";
const VALUE = "s3cret-value-never-shown";

// What the browser was asked over the socket, read for the one argument it should carry.
const CallSchema = z.object({ method: z.literal("tools/call"), params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) });

// What a browser answers over the socket: the extension's own MCP result.
interface BrowserAnswer {
    readonly jsonrpc: "2.0";
    readonly id: number;
    readonly result: { readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly isError: boolean };
}

// The browser's own part, as the test plays it: what it does with the ticket once it has it.
type Browser = (ticket: string, desk: SecretTicketDesk, signal: AbortSignal) => Promise<BrowserAnswer>;

// The answer a browser gives over the socket for what its door said: typed, or the door's sentence as its refusal.
const relayed = (door: TicketRedemption): BrowserAnswer =>
    door.ok
        ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `Typed into the focused ${door.page.field} field.` }], isError: false } }
        : { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: door.refusal }], isError: true } };

// The browser presents its ticket once, as card `card`, for the login page's password field.
const presents =
    (card = "chrome", field: TicketPage["field"] = "password"): Browser =>
    async (ticket, desk, signal) =>
        relayed(await desk.redeem(card, { ticket, url: PAGE, field }, signal));

const stage = (over: { online?: boolean; tools?: unknown; browser?: Browser } = {}) => {
    let clock = 1_000_000;
    const calls: unknown[] = [];
    const doors: TicketRedemption[] = [];
    let browser: Browser = over.browser ?? presents();
    // Every redemption the door made, for a test to read what the browser was told.
    const watched: SecretTicketDesk = {
        typeIn: async (args) => await desk.typeIn(args),
        redeem: async (card, request, signal) => {
            const door = await desk.redeem(card, request, signal);
            doors.push(door);
            return door;
        },
    };
    const hub: Pick<WebExtHub, "online" | "offline" | "knownTools" | "mcp"> = {
        online: () => over.online ?? true,
        offline: (id) => `"${id}" is not connected right now: that browser is closed, or its computer is asleep.`,
        knownTools: () => ("tools" in over ? over.tools : { tools: [{ name: "describe" }, { name: "type_ticket" }] }),
        mcp: async (_id, payload, options) => {
            calls.push(payload);
            const signal = options?.signal ?? new AbortController().signal;
            const call = CallSchema.parse(payload);
            const ticket = z.string().parse(call.params.arguments["ticket"]);
            // The socket gives up with its caller, as oRPC's does: the browser may carry on, but nobody hears it.
            return await Promise.race([
                browser(ticket, watched, signal),
                new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
            ]);
        },
    };
    const desk = createSecretTickets({ hub, callTimeoutMs: 600_000, now: () => clock });
    return {
        calls,
        doors,
        advance: (ms: number) => {
            clock += ms;
        },
        setBrowser: (next: Browser) => {
            browser = next;
        },
        desk,
    };
};

// A guard that releases the value for the page it was shown, and remembers what it was shown.
const guard = (answer: TicketAnswer = { value: VALUE }) => {
    const seen: TicketPage[] = [];
    const redeem = jest.fn(async (page: TicketPage): Promise<TicketAnswer> => {
        seen.push(page);
        return answer;
    });
    return { seen, redeem };
};

test("the browser is handed a ticket and nothing else, and the page it names is what the guard judges", async () => {
    const staged = stage();
    staged.setBrowser(presents());
    const { seen, redeem } = guard();
    const typed = await staged.desk.typeIn({ card: "chrome", secret: "GRAFANA_ADMIN_PASSWORD", redeem });
    expect(typed).toEqual({ ok: true, host: "grafana.example.com", field: "password" });
    expect(seen).toEqual([{ url: PAGE, host: "grafana.example.com", field: "password" }]);

    // Over the socket: the ticket tool, a ticket of 256 random bits, and not a word more.
    const call = CallSchema.parse(staged.calls[0]);
    expect(call.params.name).toBe("type_ticket");
    expect(Object.keys(call.params.arguments)).toEqual(["ticket"]);
    expect(call.params.arguments["ticket"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(staged.calls)).not.toContain(VALUE);
    expect(JSON.stringify(staged.calls)).not.toContain("GRAFANA_ADMIN_PASSWORD");
    // The value went to the browser on its door's answer, and only there.
    expect(staged.doors).toEqual([{ ok: true, value: VALUE, secret: "GRAFANA_ADMIN_PASSWORD", page: { url: PAGE, host: "grafana.example.com", field: "password" } }]);
});

test("a ticket is good once: a second presentation is refused and the guard is not run again", async () => {
    const staged = stage();
    staged.setBrowser(async (ticket, desk, signal) => {
        const first = await desk.redeem("chrome", { ticket, url: PAGE, field: "password" }, signal);
        await desk.redeem("chrome", { ticket, url: PAGE, field: "password" }, signal);
        return relayed(first);
    });
    const { redeem } = guard();
    expect(await staged.desk.typeIn({ card: "chrome", secret: "S", redeem })).toMatchObject({ ok: true });
    expect(staged.doors[1]).toEqual({ ok: false, status: 409, refusal: "That ticket was already used: each one types a secret once.", secret: "S" });
    expect(redeem).toHaveBeenCalledTimes(1);
});

test("a ticket left a minute uncollected has lapsed, and the browser's refusal says so", async () => {
    const staged = stage();
    staged.setBrowser(async (ticket, desk, signal) => {
        staged.advance(60_001);
        return relayed(await desk.redeem("chrome", { ticket, url: PAGE, field: "password" }, signal));
    });
    const { redeem } = guard();
    const typed = await staged.desk.typeIn({ card: "chrome", secret: "S", redeem });
    expect(typed).toEqual({ ok: false, refusal: "That ticket expired: a browser has 60 s to collect a secret after it is asked to type it." });
    expect(staged.doors[0]).toMatchObject({ ok: false, status: 410 });
    expect(redeem).not.toHaveBeenCalled();
});

test("a ticket at the edge of its minute is still good", async () => {
    const staged = stage();
    staged.setBrowser(async (ticket, desk, signal) => {
        staged.advance(60_000);
        return relayed(await desk.redeem("chrome", { ticket, url: PAGE, field: "text" }, signal));
    });
    expect(await staged.desk.typeIn({ card: "chrome", secret: "S", redeem: guard().redeem })).toEqual({ ok: true, host: "grafana.example.com", field: "text" });
});

test("a ticket presented by another browser is refused, and burnt for its own browser too", async () => {
    const staged = stage();
    staged.setBrowser(async (ticket, desk, signal) => {
        await desk.redeem("work-brave", { ticket, url: PAGE, field: "password" }, signal);
        return relayed(await desk.redeem("chrome", { ticket, url: PAGE, field: "password" }, signal));
    });
    const { redeem } = guard();
    const typed = await staged.desk.typeIn({ card: "chrome", secret: "S", redeem });
    expect(staged.doors[0]).toEqual({ ok: false, status: 403, refusal: "That ticket was issued to another browser.", secret: "S" });
    expect(typed).toEqual({ ok: false, refusal: "That ticket was already used: each one types a secret once." });
    expect(redeem).not.toHaveBeenCalled();
});

test("the guard's refusal is the agent's to read, word for word, and no value leaves", async () => {
    const staged = stage();
    staged.setBrowser(presents());
    const typed = await staged.desk.typeIn({ card: "chrome", secret: "S", redeem: guard({ refusal: "S may only be typed on grafana.internal." }).redeem });
    expect(typed).toEqual({ ok: false, refusal: "S may only be typed on grafana.internal." });
    expect(staged.doors).toEqual([{ ok: false, status: 403, refusal: "S may only be typed on grafana.internal.", secret: "S" }]);
});

test("a guard that throws hands nothing over, and its words go nowhere", async () => {
    const staged = stage();
    staged.setBrowser(presents());
    const redeem = async (): Promise<TicketAnswer> => {
        throw new Error(`store exploded near ${VALUE}`);
    };
    const typed = await staged.desk.typeIn({ card: "chrome", secret: "S", redeem });
    expect(typed).toEqual({ ok: false, refusal: "This sandbox could not release that secret just now, so nothing was typed. Try again." });
    expect(JSON.stringify(staged.doors)).not.toContain(VALUE);
});

test("a page that is no web page is refused before the guard is asked", async () => {
    const staged = stage();
    staged.setBrowser(async (ticket, desk, signal) => relayed(await desk.redeem("chrome", { ticket, url: "chrome://settings", field: "text" }, signal)));
    const { redeem } = guard();
    expect(await staged.desk.typeIn({ card: "chrome", secret: "S", redeem })).toEqual({
        ok: false,
        refusal: "That page is not an ordinary web page, so no secret is typed into it.",
    });
    expect(redeem).not.toHaveBeenCalled();
});

test("once the call is over its ticket is gone: presented afterwards, it is not one anybody is waiting on", async () => {
    const staged = stage();
    let kept = "";
    staged.setBrowser(async (ticket, desk, signal) => {
        kept = ticket;
        return relayed(await desk.redeem("chrome", { ticket, url: PAGE, field: "password" }, signal));
    });
    await staged.desk.typeIn({ card: "chrome", secret: "S", redeem: guard().redeem });
    expect(await staged.desk.redeem("chrome", { ticket: kept, url: PAGE, field: "password" }, new AbortController().signal)).toEqual({
        ok: false,
        status: 404,
        refusal: "That ticket is not one this sandbox is waiting on: it was never issued, or the call it was for has ended.",
    });
    // Nor is a ticket nobody minted.
    expect(await staged.desk.redeem("chrome", { ticket: "guessed", url: PAGE, field: "password" }, new AbortController().signal)).toMatchObject({ status: 404 });
});

test("a turn that stops while the person is still deciding stops the guard with it, and nothing is handed over", async () => {
    const staged = stage();
    staged.setBrowser(presents());
    const stop = new AbortController();
    const asking = Promise.withResolvers<void>();
    let guardStopped = false;
    // The person's approval card, open until the guard is told to stop.
    const redeem = async (_page: TicketPage, signal: AbortSignal): Promise<TicketAnswer> => {
        asking.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        guardStopped = signal.aborted;
        // An approval card answered in the same breath as the stop: too late to count.
        return { value: VALUE };
    };
    const typing = staged.desk.typeIn({ card: "chrome", secret: "S", redeem, signal: stop.signal });
    await asking.promise;
    stop.abort();
    const typed = await typing;
    expect(typed).toEqual({ ok: false, refusal: "Stopped before the browser finished typing the secret." });
    // The browser's own presentation carries on after the socket gave up; let it land.
    await Bun.sleep(0);
    expect(guardStopped).toBe(true);
    expect(staged.doors).toEqual([{ ok: false, status: 410, refusal: "The call this ticket was for has ended, so the secret was not handed over.", secret: "S" }]);
});

test("a browser that says it typed without ever collecting the secret is not believed", async () => {
    const staged = stage();
    staged.setBrowser(async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Typed." }], isError: false } }));
    expect(await staged.desk.typeIn({ card: "chrome", secret: "S", redeem: guard().redeem })).toEqual({
        ok: false,
        refusal: `"chrome" said it typed the secret, but it never collected it from this sandbox, so nothing was typed.`,
    });
});

test("a browser that is away, has not listed its tools, or is too old for tickets is refused before a ticket exists", async () => {
    const { redeem } = guard();
    const away = stage({ online: false });
    expect(await away.desk.typeIn({ card: "chrome", secret: "S", redeem })).toEqual({
        ok: false,
        refusal: `"chrome" is not connected right now: that browser is closed, or its computer is asleep.`,
    });
    const unlisted = stage({ tools: undefined });
    expect(await unlisted.desk.typeIn({ card: "chrome", secret: "S", redeem })).toEqual({
        ok: false,
        refusal: `"chrome" has not said what it can do yet: it has only just connected. Try again in a moment.`,
    });
    const old = stage({ tools: { tools: [{ name: "describe" }, { name: "fill" }] } });
    expect(await old.desk.typeIn({ card: "chrome", secret: "S", redeem })).toEqual({
        ok: false,
        refusal: `The Intentic extension in "chrome" is too old to type a stored secret. Ask the owner to update it (or reinstall it from the store), then try again.`,
    });
    expect([...away.calls, ...unlisted.calls, ...old.calls]).toEqual([]);
    expect(redeem).not.toHaveBeenCalled();
});
