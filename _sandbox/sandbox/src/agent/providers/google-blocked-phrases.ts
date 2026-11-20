/* GOOGLE TURNS AWAY A REQUEST BY A PHRASE IN IT, AND SAYS IT IS OUT OF QUOTA. Antigravity answers any request whose text
   holds `tools.opencode.session_move` with a bare 429 "Resource has been exhausted (e.g. check quota)." in under a second,
   on every account and every model behind it (Gemini 3.8 Flash and Claude Opus 4.6 Thinking alike), while the same
   accounts answer anything else. OpenCode writes that phrase into every system prompt it sends ("consider using `execute`
   to call `tools.opencode.session_move` …"), so every Gemini turn on OpenCode was refused as a throttle and retried until
   it gave up, with Usage left rightly showing room no one could use (stork-97z8, 2026-11-20). Bisected on the request the
   turn sent: `tools.opencode.session_move` alone is refused; `opencode.session_move`, `tools.opencode.x` and
   `tools.foo.session_move` are answered; the whole request answers once the phrase is written as below.

   Each phrase is rewritten to a spelling that means the same to the model: `tools.opencode['session_move']` is the same
   call in the JavaScript OpenCode's `execute` tool runs. Rewritten wherever it appears in the body (system prompt, the
   history a model quoted it in, a tool result), since one occurrence anywhere refuses the whole request. */
const REWRITES: readonly (readonly [blocked: string, said: string])[] = [["tools.opencode.session_move", "tools.opencode['session_move']"]];

/** The request body with every phrase Google refuses requests for written another way; the same bytes when it holds none. */
export const withoutGoogleBlockedPhrases = (raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
    const text = new TextDecoder().decode(raw);
    if (!REWRITES.some(([blocked]) => text.includes(blocked))) {
        return raw;
    }
    return new TextEncoder().encode(REWRITES.reduce((rewritten, [blocked, said]) => rewritten.replaceAll(blocked, said), text));
};
