import { hostProblem, IDENTITY_BODY_MAX, identityFetcher } from "./s2s-wiring.js";

// What the sandbox-to-sandbox layer refuses to reach (a contact's address can never aim it at its own network), and how
// much of an identity it reads.

const ZONE = "intentic.example";
const PRIVATE = "it is a loopback, private or link-local address";
const LOCAL = "it is a name only a local network answers";

test("a loopback, private, link-local or metadata address is no address, by name or with a port", () => {
    expect(["127.0.0.1", "127.0.0.1:8080", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"].map((host) => hostProblem(host, ZONE))).toEqual([
        PRIVATE,
        PRIVATE,
        PRIVATE,
        PRIVATE,
        PRIVATE,
        PRIVATE,
        PRIVATE,
        PRIVATE,
    ]);
    expect(["localhost", "localhost:3000", "box", "printer.local", "db.internal", "nas.lan", "router.home.arpa", "app.localhost"].map((host) => hostProblem(host, ZONE))).toEqual([
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
        LOCAL,
    ]);
    expect(hostProblem(`sb1.local.${ZONE}`, ZONE)).toBe("it is this platform's name for 127.0.0.1");
});

test("a public host or address, a platform sandbox host and an own domain are reachable", () => {
    expect(["sandbox-abc.intentic.example", "messages.acme.test", "93.184.216.34", "acme.test:8443", "local.example.com"].map((host) => hostProblem(host, ZONE))).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
    ]);
});

test("the identity fetch asks no host the policy refuses, and reads no identity past its cap", async () => {
    const asked: string[] = [];
    const answering =
        (body: string) =>
        async (url: string): Promise<Response> => {
            asked.push(url);
            return new Response(body, { status: 200 });
        };
    const refused = identityFetcher(answering("{}"), (host) => `https://${host}`, (host) => hostProblem(host, ZONE));
    expect(await refused("169.254.169.254")).toEqual({ ok: false, status: 403, error: `169.254.169.254 is no address this sandbox fetches from: ${PRIVATE}` });
    expect(asked).toEqual([]);

    const huge = identityFetcher(answering(`"${"x".repeat(IDENTITY_BODY_MAX)}"`), (host) => `https://${host}`);
    expect(await huge("a.example")).toEqual({ ok: false, error: "its identity is larger than 64 KiB, which no identity document is" });
    const small = identityFetcher(answering(`{"v":1}`), (host) => `https://${host}`);
    expect(await small("a.example")).toEqual({ ok: true, body: { v: 1 } });
    expect(asked).toEqual(["https://a.example/s2s/identity", "https://a.example/s2s/identity"]);
});
