import { aiAgentOf, aiFetchBatch, aiFetchOf, fetchKindOf } from "./ai-fetch";

describe("aiAgentOf", () => {
    it("names the AI agents by their published user-agent tokens", () => {
        expect(aiAgentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot")).toBe(
            "ChatGPT-User",
        );
        expect(aiAgentOf("Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)")).toBe("OAI-SearchBot");
        expect(aiAgentOf("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe("GPTBot");
        expect(aiAgentOf("Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/)")).toBe("ClaudeBot");
        expect(aiAgentOf("Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)")).toBe("PerplexityBot");
        expect(aiAgentOf("CCBot/2.0 (https://commoncrawl.org/faq/)")).toBe("CCBot");
    });

    it("ignores browsers and ordinary search crawlers", () => {
        expect(
            aiAgentOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"),
        ).toBeUndefined();
        expect(aiAgentOf("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBeUndefined();
        expect(aiAgentOf("")).toBeUndefined();
    });
});

describe("fetchKindOf", () => {
    it("counts pages, Markdown mirrors, llms files and robots.txt, and skips assets", () => {
        expect(fetchKindOf("/")).toBe("page");
        expect(fetchKindOf("/compare/conductor/")).toBe("page");
        expect(fetchKindOf("/pricing")).toBe("page");
        expect(fetchKindOf("/compare/conductor.md")).toBe("markdown");
        expect(fetchKindOf("/llms.txt")).toBe("llms");
        expect(fetchKindOf("/llms-index.txt")).toBe("llms");
        expect(fetchKindOf("/llms-full.txt")).toBe("llms");
        expect(fetchKindOf("/robots.txt")).toBe("robots");
        expect(fetchKindOf("/assets/intentic-logo-sized.png")).toBeUndefined();
        expect(fetchKindOf("/_astro/index.css")).toBeUndefined();
    });
});

describe("aiFetchOf and aiFetchBatch", () => {
    it("counts an assistant reading a page, with no person profile", () => {
        const fetched = aiFetchOf("Claude-User/1.0", "/facts/", 200, undefined);
        expect(fetched).toEqual({ agent: "Claude-User", kind: "page", path: "/facts/", status: 200, verifiedBotCategory: undefined });
        const body = aiFetchBatch("key", "https://intentic.dev", fetched!, new Date("2026-10-19T12:00:00Z"));
        expect(body.batch[0]?.event).toBe("site_ai_fetch");
        expect(body.batch[0]?.distinct_id).toBe("ai-Claude-User");
        expect(body.batch[0]?.properties.$process_person_profile).toBe(false);
        expect("verified_bot_category" in (body.batch[0]?.properties ?? {})).toBe(false);
    });

    it("counts nothing for a person or for an asset", () => {
        expect(aiFetchOf("Mozilla/5.0 Chrome/130.0", "/", 200, undefined)).toBeUndefined();
        expect(aiFetchOf("GPTBot/1.2", "/favicon.svg", 200, "AI Crawler")).toBeUndefined();
    });

    it("keeps Cloudflare's verified-bot category when there is one", () => {
        expect(aiFetchOf("GPTBot/1.2", "/llms.txt", 200, "AI Crawler")?.verifiedBotCategory).toBe("AI Crawler");
        expect(aiFetchOf("GPTBot/1.2", "/llms.txt", 200, "")?.verifiedBotCategory).toBeUndefined();
    });
});
