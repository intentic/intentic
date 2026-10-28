import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";

// Devin's CLI refuses session/load for a session its store lacks with its own -32016 "Session not found", tagging the
// error's data with the kind instead of using the protocol's resource_not_found code.
const DevinSessionNotFound = z.object({ "cognition.ai/errorKind": z.literal("session_not_found") });

// Whether a session/load refusal says the agent has no such session, the one refusal that retires a chat's session id:
// the protocol's resource_not_found, or the kind Devin's CLI names it by.
export const sessionMissing = (error: RequestError): boolean =>
    error.code === RequestError.resourceNotFound().code || DevinSessionNotFound.safeParse(error.data).success;
