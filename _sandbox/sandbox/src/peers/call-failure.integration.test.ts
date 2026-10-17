import { ORPCError, os } from "@orpc/server";
import { callFailure } from "./call-failure.js";
import { failureOf, orpcLink } from "./orpc-link.testing.js";

// The failures callFailure names, made by the real transport rather than written out: an oRPC client on the accepting
// side of a websocket, a peer dialling in and serving the router, as the hub and a runner or device are wired. A new
// oRPC that rejects a dropped call differently fails here, not in an agent re-running a command that already ran.

const router = {
    hang: os.handler(async () => await new Promise<never>(() => undefined)),
    refuse: os.handler(() => {
        throw new ORPCError("BAD_REQUEST", { message: "socket hang up while it ran its own command" });
    }),
};

type Client = { hang: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<never>; refuse: () => Promise<never> };
const linked = () => orpcLink<Client>(router);

const kindOf = (error: Error): string => callFailure("device", "laptop", "run_command", error, 60_000).kind;

test("a peer whose socket goes away mid-call is said as dropped", async () => {
    const { client, peer, close } = await linked();
    try {
        const pending = failureOf(client.hang());
        await new Promise((resolve) => setTimeout(resolve, 20));
        peer.terminate();
        expect(kindOf(await pending)).toBe("dropped");
        // The next call finds the socket closed: oRPC's link refuses the send outright.
        expect(kindOf(await failureOf(client.hang()))).toBe("dropped");
    } finally {
        close();
    }
});

test("a call that outran its deadline is said as a timeout, and a caller's own abort is passed through", async () => {
    const { client, close } = await linked();
    try {
        expect(kindOf(await failureOf(client.hang(undefined, { signal: AbortSignal.timeout(20) })))).toBe("timeout");
        const stop = new AbortController();
        const stopped = failureOf(client.hang(undefined, { signal: stop.signal }));
        stop.abort();
        expect(kindOf(await stopped)).toBe("other");
    } finally {
        close();
    }
});

// The link was up and the peer answered: its error is its own, whatever its words, and reaches the agent as it was.
test("an error the peer answered with passes through, even worded like a dropped socket", async () => {
    const { client, close } = await linked();
    try {
        const answered = callFailure("device", "laptop", "run_command", await failureOf(client.refuse()), 60_000);
        expect(answered).toEqual({ kind: "other", text: "socket hang up while it ran its own command" });
    } finally {
        close();
    }
});
