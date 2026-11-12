import type { McpTool } from "@intentic/sandbox-contract/peer-mcp-server";
import type { SandboxKey } from "../store.js";
import { CHATGPT_KIT } from "./chatgpt/chatgpt-kit.js";
import type { Kit } from "./kit.js";

// Every site kit this extension ships (kit.ts says what one is). A new kit is a folder beside chatgpt/ and a line here.
const KITS: readonly Kit[] = [CHATGPT_KIT];

// Their tools, spread into the extension's tool surface (mcp.ts).
export const KIT_TOOLS: readonly McpTool<SandboxKey>[] = KITS.flatMap((kit) => kit.tools);
