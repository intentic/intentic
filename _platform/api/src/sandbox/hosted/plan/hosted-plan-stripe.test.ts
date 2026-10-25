import { stripeGateway, StripeError } from "./hosted-plan-stripe.js";

const client = { stripeSecretKey: "test-key", stripeApiUrl: "https://stripe.test/v1" };

const answering = (answer: (url: string, init?: RequestInit) => Response): typeof fetch => Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => answer(String(url), init),
    { preconnect: fetch.preconnect },
);

test("GET reads a price and sends only the configured bearer", async () => {
    const calls: { url: string; method: string; authorization: string | null; body: BodyInit | null | undefined }[] = [];
    const gateway = stripeGateway(client, answering((url, init) => {
        calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: init?.body });
        return Response.json({ active: true, livemode: true, unit_amount: 900, currency: "usd", recurring: { interval: "month" } });
    }));
    expect(await gateway.price("price/1")).toEqual({ active: true, livemode: true, unitAmount: 900, currency: "usd", interval: "month" });
    expect(calls).toEqual([{ url: "https://stripe.test/v1/prices/price%2F1", method: "GET", authorization: "Bearer test-key", body: undefined }]);
});

test("POST keeps form encoding and DELETE keeps its method", async () => {
    const calls: { url: string; method: string | undefined; type: string | null; body: string }[] = [];
    const gateway = stripeGateway(client, answering((url, init) => {
        calls.push({ url, method: init?.method, type: new Headers(init?.headers).get("content-type"), body: String(init?.body) });
        return Response.json({ url: "https://billing.test/session" });
    }));
    expect(await gateway.portalSession("cus &1", "https://app.test/billing?a=1")).toEqual({ url: "https://billing.test/session" });
    await gateway.deleteCustomer("cus/1");
    expect(calls).toEqual([
        { url: "https://stripe.test/v1/billing_portal/sessions", method: "POST", type: "application/x-www-form-urlencoded", body: "customer=cus+%261&return_url=https%3A%2F%2Fapp.test%2Fbilling%3Fa%3D1" },
        { url: "https://stripe.test/v1/customers/cus%2F1", method: "DELETE", type: "application/x-www-form-urlencoded", body: "" },
    ]);
});

test.each(["get", "post", "delete"])("%s preserves Stripe's actionable refusal and HTTP status", async (method) => {
    const gateway = stripeGateway(client, answering(() => Response.json({ error: { message: "No such customer" } }, { status: 404 })));
    const request = method === "get" ? gateway.price("price-1") : method === "post" ? gateway.portalSession("cus-1", "https://app.test") : gateway.deleteCustomer("cus-1");
    const error: unknown = await request.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({ status: 404, message: "Stripe refused: No such customer" });
});

test("a non-Stripe refusal keeps bounded evidence instead of the whole proxy page", async () => {
    const gateway = stripeGateway(client, answering(() => new Response("x".repeat(20_000), { status: 502 })));
    const error: unknown = await gateway.price("price-1").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({ status: 502, message: `Stripe GET /prices/price-1 failed (HTTP 502): ${"x".repeat(300)}…` });
});
