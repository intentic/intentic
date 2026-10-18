import { z } from "zod";

// Agent experiments share conversation-stable arms; the sandbox settings schema owns their persisted shape.
export const claudeExperimentSettings = {
    // Claude Code turns itself out of tool search whenever its base URL is not Anthropic's own host, and the privacy
    // shield's gateway is a loopback address, so every shielded native Claude turn paid every MCP tool's schema on every
    // call (2026-10-18: a median 83k-token prompt before the first tool ran). The gateway forwards `tool_reference`
    // blocks and the beta header untouched, so this asks for it by name. Native Claude only: a translator or minted
    // endpoint may not speak the beta.
    toolSearch: z
        .boolean()
        .default(true)
        .describe(
            "Load the schemas of connected tools (browsers, devices, accounts, phones) only when the agent looks one up, instead of sending all of them with every request. The tools the agent leans on every turn stay loaded. Applies to Claude models on the Claude Code loop.",
        ),
    // Both arms set the CLI's switch explicitly, so a shielded turn and an unshielded one compare the same two things.
    toolSearchHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
            "What share of conversations to run with every tool loaded up front, so the two can be compared. Whole conversations rather than individual turns, because switching mid-conversation would rewrite the prompt the cache holds.",
        ),
    // Until 2026-10-18 this switch was read by nothing. The guidance paragraphs whose condition moves between turns (who
    // is watching, which of the owner's machines, browsers and phones are online) sat in the system block, so each move
    // rewrote the whole conversation to the provider's cache, and where Claude Code records a session's system prompt
    // once the move never reached the model. Now they ride the turn's message, said when they changed.
    stableSystemPrompt: z
        .boolean()
        .default(true)
        .describe(
            "Keep the instructions identical between turns so the provider can cache them, saying what changes between turns (who is watching, which of your computers, browsers and phones are connected) on the message instead, and only when it changed. Applies to the Claude Code loop.",
        ),
    stableSystemPromptHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
            "What share of conversations to run with those changing paragraphs kept in the instructions, so the two can be compared. Whole conversations rather than individual turns, because moving them mid-conversation would itself rewrite the cached prompt.",
        ),
    coldTrim: z
        .boolean()
        .default(true)
        .describe(
            "Resume large Claude Code conversations with older tool output cleared once their prompt cache has expired. Keeps the conversation and tool calls, with directions to recover cleared output, and shows a trim notice.",
        ),
    coldTrimHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe(
            "What share of conversations to resume whole when their cache is cold, so opening prompt size and failed tool calls can be compared. Whole conversations keep the same arm across follow-up turns.",
        ),
    coldTrimMinTokens: z
        .number()
        .int()
        .min(0)
        .default(100_000)
        .describe(
            "How many measured context tokens a Claude Code session must exceed before a cold follow-up can clear older tool output. Smaller sessions save little from trimming.",
        ),
};

export const iqSearchSettings = {
    iqSearch: z
        .boolean()
        .default(false)
        .describe("Teach the agent how to use this workspace's own search tool, rather than leaving it to grep around."),
    iqSearchHoldout: z
        .number()
        .min(0)
        .max(1)
        .default(0)
        .describe(
            "What share of conversations to run without that teaching, so the two can be compared. Whole conversations rather than individual turns, because once the teaching is in a session, withholding it from the next request does not make the model forget it.",
        ),
};
