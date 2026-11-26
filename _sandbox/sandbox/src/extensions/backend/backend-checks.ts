import type { WatchCheck, WatchCheckAnswer } from "@intentic/extension-api/runtime";
import { ExtensionWatchAnswerSchema, ExtensionWatchCheckSchema } from "@intentic/sandbox-contract/extension-protocol";
import { z } from "zod";

// The wire between the daemon's automations engine and the backend host's `POST /checks/<id>` door (2026-11-26): one
// watch's check in, for the kind the extension serves (`api.checks.serve`), and its answer out. Both ends parse with
// these, so the host (a child process that must not load the daemon's services) and the engine cannot drift on the shape.

const CheckRequestSchema = z.object({ check: ExtensionWatchCheckSchema });
const CheckAnswerSchema = z.object({ answer: ExtensionWatchAnswerSchema });

// The check a request to the door carries, or undefined for a body that is not one.
export const watchCheckIn = async (request: Request): Promise<WatchCheck | undefined> => {
    // allow(silent-catch): a body that is not JSON is no check, which the door answers with a 400
    const body: unknown = await request.json().catch(() => undefined);
    return CheckRequestSchema.safeParse(body).data?.check;
};

export const checkRequestBody = (check: WatchCheck): string => JSON.stringify(CheckRequestSchema.parse({ check }));

// A handler's answer as the door sends it, or undefined for one that is not an answer: an extension's code is JavaScript,
// and what it hands back is read here rather than trusted to its type.
export const watchAnswerBody = (answer: WatchCheckAnswer): string | undefined => {
    const parsed = CheckAnswerSchema.safeParse({ answer });
    return parsed.success ? JSON.stringify(parsed.data) : undefined;
};

// The answer the door sent, or undefined for a body that is not one.
export const watchAnswerFrom = async (response: Response): Promise<WatchCheckAnswer | undefined> => {
    // allow(silent-catch): a body that is not JSON is no answer, which the caller says as a check that could not run
    const body: unknown = await response.json().catch(() => undefined);
    return CheckAnswerSchema.safeParse(body).data?.answer;
};
