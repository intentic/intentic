import type { AgentEvent } from "@intentic/sandbox-contract";
import { isUnsentParameterRefusalText, mentionsSpentAllowance } from "../../agent/providers/failure-sentences.js";
import { unsentParameterFrame } from "../../agent/run/error-frames.js";

// How a vendor's failure sentence is read: one rate-limit and spent-allowance classifier for every runtime, the frame a
// coded failure becomes, and a process's stderr folded into the sentence it explains.

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// Wider than mentionsSpentAllowance, since by the time a vendor's own retries surface a sentence they are already spent.
const RATE_LIMITED = /rate.?limit|resource.?exhausted|too many requests|\b429\b/i;

// A refusal driven by quota or allowance, not a real failure: the chat offers a retry-later notice instead of a Continue
// that would just re-fail.
export const isRateLimited = (message: string): boolean => mentionsSpentAllowance(message) || RATE_LIMITED.test(message);

// One way a runtime recognizes its own failure sentence, and the code the frame then carries.
export type VendorRule = readonly [recognizes: (message: string) => boolean, code: NonNullable<ErrorFrame["code"]>];

// The frame coded by the first rule that recognizes its sentence, in the runtime's own order. A parameter this sandbox
// never sent is read first, since `400 ... not supported on this model` would otherwise read as a bad model pick.
export const vendorFailureFrame = (frame: ErrorFrame, rules: readonly VendorRule[]): ErrorFrame => {
    if (isUnsentParameterRefusalText(frame.message)) {
        return unsentParameterFrame(frame.message);
    }
    const rule = rules.find(([recognizes]) => recognizes(frame.message));
    return rule === undefined ? frame : { ...frame, code: rule[1] };
};

// A failure with its process's stderr tail folded in, so a bare exit code becomes the actual reason.
export const withStderrTail = (message: string, stderrTail: string): string => {
    const detail = stderrTail.trim();
    return detail === "" ? message : `${message}: ${detail}`;
};
