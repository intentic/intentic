import type { Account } from "./accounts.js";
import type { Http } from "./auth.js";

// Graph and Microsoft's sign-in, mocked: each answer is served in order, and an unexpected extra call fails the test.

export const account: Account = { id: "office", tenantId: "tenant", clientId: "client", refreshToken: "initial", access: "write" };

export interface MockAnswer {
    readonly body?: unknown;
    readonly status?: number;
    readonly bytes?: Uint8Array;
}

export interface MockCall {
    readonly url: string;
    readonly init: RequestInit | undefined;
}

export interface MockHttp {
    readonly http: Http;
    readonly calls: MockCall[];
}

export const httpQueue = (answers: MockAnswer[]): MockHttp => {
    const calls: MockCall[] = [];
    return {
        calls,
        http: async (url, init) => {
            calls.push({ url, init });
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error(`Unexpected mocked HTTP call to ${url}`);
            }
            const body =
                answer.bytes === undefined
                    ? answer.status === 204 || answer.status === 202
                        ? null
                        : JSON.stringify(answer.body)
                    : Uint8Array.from(answer.bytes);
            return new Response(body, { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
        },
    };
};

// The headers a mocked call carried; every client here passes them as a plain record.
export const headersOf = (call: MockCall | undefined): Headers => new Headers(call?.init?.headers);
