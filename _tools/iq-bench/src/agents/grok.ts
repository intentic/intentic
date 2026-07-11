import { type AgentAdapter, onPath } from "./adapter.js";

// Grok CLI's headless flag surface is not reliably documented — availability-gated stub so the harness
// degrades to two vendors with no other changes. Fill in run() once the flags are verified.
export const grokAdapter: AgentAdapter = {
    id: "grok",
    available: () => onPath("grok") && process.env["XAI_API_KEY"] !== undefined,
    run: () => {
        throw new Error("grok adapter: not implemented — verify the CLI's headless flags and fill in run()");
    },
};
