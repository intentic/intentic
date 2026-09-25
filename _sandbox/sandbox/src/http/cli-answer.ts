import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";

// What a route the agent's CLIs call answers: status, body and type, relayed from the platform or composed here, and
// printed the same way by every CLI.
export interface CliAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

export const jsonAnswer = (status: number, payload: unknown): CliAnswer => ({ status, body: JSON.stringify(payload), contentType: "application/json" });

// The one error shape the CLIs print: a type a script can branch on, and a sentence the model reads.
export const refusalAnswer = (status: number, type: string, message: string): CliAnswer => jsonAnswer(status, { error: { type, message } });

export const answerResponse = (c: Context<AppEnv>, answer: CliAnswer, headers: Readonly<Record<string, string>> = {}): Response =>
    c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType, ...headers });

// A CLI call's JSON body as its fields, or the refusal naming the `call` and the `shape` it takes.
export const cliBody = async (c: Context<AppEnv>, call: string, shape: string): Promise<Readonly<Record<string, unknown>> | Response> => {
    try {
        const body: unknown = await c.req.json();
        return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    } catch {
        return c.json({ error: { type: "invalid_request", message: `the ${call} body must be JSON: ${shape}` } }, 400);
    }
};
