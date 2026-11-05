import type { SafetyVerdict } from "@intentic/sandbox-contract/policy/safety-policy";
import { RoleModelUnsetError } from "../seams/role-model-unset.js";
import { SecretJudgeFactsError } from "./secret-judge-facts-error.js";

export type CommandVerdict = SafetyVerdict & { readonly unavailable?: true };

// Only credential access under an enforcing judge fails closed. Off and watch keep their standing-rule behavior.
export const unavailableCommandVerdict = (error: Error, secretAccess: boolean): CommandVerdict => {
    const why = error instanceof RoleModelUnsetError ? "No model is set for the safety judge"
        : error instanceof SecretJudgeFactsError ? "Secret-reference metadata could not be collected"
        : "The safety judge did not return a usable verdict";
    if (!secretAccess) {
        return { decision: "allow", sentence: `${why}, so this was decided by the standing rule alone.` };
    }
    return {
        unavailable: true,
        decision: "ask",
        sentence: `${why}. Credential access requires a safety verdict.`,
    };
};
