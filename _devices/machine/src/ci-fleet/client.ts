import { createConnection } from "node:net";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { FLEET_SOCKET } from "./paths.js";
import { type FleetAnswer, FleetAnswerSchema, type FleetRequest } from "./protocol.js";

/* THE PERSON'S AGENT ASKING THE FLEET SERVICE: one line out, one line back. A service that is not there, or a socket
   this account may not open, is a FleetUnavailable whose words say which and what fixes it; a service that answered
   `ok: false` is a plain Error in its words. */

export class FleetUnavailable extends Error {
    override readonly name = "FleetUnavailable";
}

const unavailableWords = (code: string | undefined, path: string): string => {
    if (code === "ENOENT" || code === "ECONNREFUSED") {
        return `The CI fleet service is not running on this computer (no ${path}): \`sudo intentic-machine ci-fleet install --user $USER\` sets it up, \`systemctl status intentic-ci-fleet\` says why one that is installed stopped.`;
    }
    if (code === "EACCES" || code === "EPERM") {
        return `This account may not ask the CI fleet service (${path} is for the account it was installed for, and that account's group).`;
    }
    return `Could not reach the CI fleet service at ${path}`;
};

export const askFleet = async (request: FleetRequest, timeoutMs: number, path: string = FLEET_SOCKET): Promise<FleetAnswer & { ok: true }> => {
    const text = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(path);
        let received = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`The CI fleet service did not answer \`${request.verb}\` within ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs);
        socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk: Buffer) => {
            received += chunk.toString("utf8");
        });
        socket.on("end", () => {
            clearTimeout(timer);
            resolve(received);
        });
        socket.on("error", (error: Error) => {
            clearTimeout(timer);
            const code = errnoCode(error);
            reject(code === undefined || received !== "" ? new Error(errorMessage(error)) : new FleetUnavailable(`${unavailableWords(code, path)} (${code}).`));
        });
    });
    const answer = parseJsonWith(text.trim(), FleetAnswerSchema);
    if (answer === undefined) {
        throw new Error(`The CI fleet service answered with something other than an answer: ${JSON.stringify(text.slice(0, 200))}`);
    }
    if (!answer.ok) {
        throw new Error(answer.error);
    }
    return answer;
};
