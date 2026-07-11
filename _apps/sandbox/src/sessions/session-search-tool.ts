import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listWorkspaceSessions, readWorkspaceSession } from "./sessions.js";

// The agent-facing "search past chats" tool (in-process SDK MCP server, the uiServer/discord voice pattern).
// Gated by the sandbox's searchPastChats setting — streamAgent only injects it when the toggle is on. It reuses
// the history store (listWorkspaceSessions/readWorkspaceSession) and does a naive case-insensitive keyword scan.
// ponytail: substring scan over ≤50 sessions read on demand; add ranking/embeddings if recall matters.

// How many matching turns to return, and how much text to show around each hit.
const MAX_MATCHES = 20;
const SNIPPET = 400;

export const createSessionSearchServer = (dir: string, currentSessionId?: string): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "pastChats",
        tools: [
            tool(
                "search_past_chats",
                "Search this workspace's earlier conversations for relevant details the user may be referring to. Returns matching snippets tagged with the conversation each came from. Use it when the user references something discussed in a previous chat that isn't in the current conversation.",
                { query: z.string().min(2).describe("Keywords or a phrase to look for across past chats") },
                async ({ query }) => {
                    const needle = query.toLowerCase();
                    // Skip the current session — it's already the live context being resumed.
                    const sessions = (await listWorkspaceSessions(dir)).filter((session) => session.id !== currentSessionId);
                    const hits: string[] = [];
                    for (const session of sessions) {
                        for (const message of await readWorkspaceSession(dir, session.id)) {
                            const at = message.text.toLowerCase().indexOf(needle);
                            if (at === -1) {
                                continue;
                            }
                            const start = Math.max(0, at - Math.floor(SNIPPET / 2));
                            hits.push(`[${session.title}] ${message.role}: …${message.text.slice(start, start + SNIPPET)}…`);
                            if (hits.length >= MAX_MATCHES) {
                                break;
                            }
                        }
                        if (hits.length >= MAX_MATCHES) {
                            break;
                        }
                    }
                    const text = hits.length > 0 ? hits.join("\n\n") : `No past chats mention "${query}".`;
                    return { content: [{ type: "text", text }] };
                },
            ),
        ],
    });
