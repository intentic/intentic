import { AgentDomainPolicySchema, type AgentDomainPolicy } from "@intentic/sandbox-contract";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// An execution boundary is the owner's decision, not part of the workspace every turn may edit.
export const agentDomainPolicyDocument = defineDocument({
    root: "auth",
    path: "agent-domain.json",
    schema: AgentDomainPolicySchema,
});

export interface AgentDomainPolicyStore {
    readonly get: () => Promise<AgentDomainPolicy>;
    readonly set: (policy: AgentDomainPolicy) => Promise<void>;
}

export const fileAgentDomainPolicy = (path: string): AgentDomainPolicyStore => {
    const file = openDocument(agentDomainPolicyDocument, path, {
        mode: 0o600,
        fallback: () => AgentDomainPolicySchema.parse({}),
        onUnreadable: "refuse",
    });
    return {
        get: async () => {
            const state = await file.state();
            if (state.unreadable) {
                throw new Error(`agent domain policy at ${path} is unreadable (${state.detail}); refusing agent execution`);
            }
            return state.value;
        },
        set: async (policy) => { await file.update(() => AgentDomainPolicySchema.parse(policy)); },
    };
};
