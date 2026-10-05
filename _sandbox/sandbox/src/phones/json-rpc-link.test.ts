import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import type { phoneContract } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { type LinkSocket, PhoneCallError, PhoneJsonRpcLink } from "./json-rpc-link.js";

// The contract's golden wire (_shared/sandbox-contract/golden/phone-wire.json): the frames this link must send for each
// call and what it must resolve each answer to. The Android app tests against the same file.
interface Exchange {
    readonly name: string;
    readonly call: { readonly path: readonly string[]; readonly input?: unknown };
    readonly request: { readonly id: number };
    readonly response: unknown;
    readonly resolves?: unknown;
    readonly rejects?: string;
}
const wire = JSON.parse(
    readFileSync(join(packageRoot(import.meta.url), "..", "..", "_shared", "sandbox-contract", "golden", "phone-wire.json"), "utf8"),
) as {
    readonly exchanges: readonly Exchange[];
};

// A socket whose far end is the test: what the link sends is collected, what the phone says is pushed in.
const fakeSocket = () => {
    const sent: unknown[] = [];
    const listeners = { message: [] as ((event: { data: unknown }) => void)[], close: [] as (() => void)[] };
    const socket: LinkSocket = {
        send: (data) => sent.push(JSON.parse(data)),
        addEventListener: ((type: "message" | "close", listener: never) => listeners[type].push(listener)) as LinkSocket["addEventListener"],
    };
    return {
        socket,
        sent,
        answer: (frame: unknown) => {
            for (const listener of listeners.message) {
                listener({ data: Buffer.from(JSON.stringify(frame)) });
            }
        },
        close: () => {
            for (const listener of listeners.close) {
                listener();
            }
        },
    };
};

test("sends each golden request and resolves each golden answer, through the typed client every door uses", async () => {
    const far = fakeSocket();
    const client = createORPCClient(new PhoneJsonRpcLink(far.socket)) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    for (const exchange of wire.exchanges) {
        const method = exchange.call.path[0] ?? "";
        const pending = client[method]?.(exchange.call.input);
        expect(far.sent.at(-1)).toEqual(exchange.request);
        far.answer(exchange.response);
        if (exchange.rejects === undefined) {
            expect(await pending).toEqual(exchange.resolves);
        } else {
            const error = await pending?.catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(PhoneCallError);
            expect((error as Error).message).toBe(exchange.rejects);
        }
    }
});

test("the client is typed by the phone contract", () => {
    const client: ContractRouterClient<typeof phoneContract> = createORPCClient(new PhoneJsonRpcLink(fakeSocket().socket));
    expect(typeof client.describe).toBe("function");
});

test("answers that arrive out of order still reach their own calls", async () => {
    const far = fakeSocket();
    const link = new PhoneJsonRpcLink(far.socket);
    const first = link.call(["ping"], undefined, { context: {} });
    const second = link.call(["describe"], undefined, { context: {} });
    far.answer({ jsonrpc: "2.0", id: 1, result: "second" });
    far.answer({ jsonrpc: "2.0", id: 0, result: "first" });
    expect(await first).toBe("first");
    expect(await second).toBe("second");
});

test("a closed socket fails what is outstanding and refuses what comes after", async () => {
    const far = fakeSocket();
    const link = new PhoneJsonRpcLink(far.socket);
    const outstanding = link.call(["ping"], undefined, { context: {} });
    far.close();
    await expect(outstanding).rejects.toThrow("the phone closed its connection");
    await expect(link.call(["ping"], undefined, { context: {} })).rejects.toThrow("the phone closed its connection");
});

test("an aborted call stops waiting, and its late answer is dropped", async () => {
    const far = fakeSocket();
    const link = new PhoneJsonRpcLink(far.socket);
    const controller = new AbortController();
    const pending = link.call(["describe"], undefined, { context: {}, signal: controller.signal });
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
    far.answer({ jsonrpc: "2.0", id: 0, result: {} });
});

test("a frame that answers nothing outstanding, or is not JSON-RPC, is ignored", async () => {
    const far = fakeSocket();
    const link = new PhoneJsonRpcLink(far.socket);
    const pending = link.call(["ping"], undefined, { context: {} });
    far.answer({ jsonrpc: "2.0", id: 42, result: "stray" });
    far.answer("not even an object");
    far.answer({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
});
