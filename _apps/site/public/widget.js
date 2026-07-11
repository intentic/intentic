// intentic web-chat widget — a single-file embed that drops a support chat onto any website and streams the
// sandbox agent's reply. Add with:
//   <script src="https://intentic.dev/widget.js"
//           data-daemon="https://sandbox-<id>.<zone>" data-automation="<automation-id>"></script>
// It POSTs each message to <daemon>/webchat/<automation>/message and renders the SSE reply live. Style-isolated
// in a shadow root so it never collides with the host page's CSS. No dependencies, no build step.

// Parse an SSE byte stream into (event, data) frames, tolerating chunk boundaries mid-frame.
const readSSE = async (body, onFrame) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "message";
            const data = [];
            for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            onFrame(event, data.join("\n"));
        }
    }
};

(() => {
    const script = document.currentScript;
    const daemon = script?.dataset.daemon?.replace(/\/$/, "");
    const automation = script?.dataset.automation;
    if (!daemon || !automation) {
        console.error("[intentic-widget] data-daemon and data-automation are required");
        return;
    }
    const title = script.dataset.title ?? "Support";
    const endpoint = `${daemon}/webchat/${automation}/message`;

    // A stable per-visitor conversation id so follow-up messages thread together.
    const KEY = `intentic-webchat:${automation}`;
    let conversationId = localStorage.getItem(KEY);
    if (!conversationId) {
        conversationId = (crypto.randomUUID?.() ?? String(Date.now() + Math.random())).slice(0, 64);
        localStorage.setItem(KEY, conversationId);
    }

    // The client keeps recent turns and replays them with each request — the daemon injects them as thread
    // context (server-side session threading is a later step).
    const history = [];
    const HISTORY_MAX = 20;

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
        <style>
            * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
            .btn { width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:#4f46e5;color:#fff;
                   font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.2); }
            .panel { display:none;flex-direction:column;width:360px;max-width:calc(100vw - 40px);height:520px;
                     max-height:calc(100vh - 120px);background:#fff;border-radius:12px;overflow:hidden;
                     box-shadow:0 8px 30px rgba(0,0,0,.25);position:absolute;bottom:70px;right:0; }
            .panel.open { display:flex; }
            .head { background:#4f46e5;color:#fff;padding:12px 16px;font-weight:600; }
            .log { flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f8f8fb; }
            .msg { padding:8px 12px;border-radius:12px;max-width:80%;white-space:pre-wrap;word-wrap:break-word;line-height:1.4;font-size:14px; }
            .user { align-self:flex-end;background:#4f46e5;color:#fff;border-bottom-right-radius:2px; }
            .agent { align-self:flex-start;background:#ececf3;color:#111;border-bottom-left-radius:2px; }
            .note { align-self:center;color:#666;font-size:12px;font-style:italic; }
            .foot { display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff; }
            .foot input { flex:1;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:14px;outline:none; }
            .foot button { border:none;background:#4f46e5;color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;font-size:14px; }
            .foot button:disabled { opacity:.5;cursor:default; }
        </style>
        <div class="panel">
            <div class="head">${title}</div>
            <div class="log"></div>
            <div class="foot">
                <input type="text" placeholder="Type a message…" />
                <button class="send">Send</button>
            </div>
        </div>
        <button class="btn" aria-label="Open chat">💬</button>`;
    document.body.appendChild(host);

    const panel = root.querySelector(".panel");
    const log = root.querySelector(".log");
    const input = root.querySelector("input");
    const sendBtn = root.querySelector(".send");
    root.querySelector(".btn").addEventListener("click", () => {
        panel.classList.toggle("open");
        if (panel.classList.contains("open")) input.focus();
    });

    const addMsg = (cls, text) => {
        const el = document.createElement("div");
        el.className = `msg ${cls}`;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    };

    let busy = false;
    const send = async () => {
        const content = input.value.trim();
        if (!content || busy) return;
        busy = true;
        sendBtn.disabled = true;
        input.value = "";
        addMsg("user", content);
        history.push({ author: "visitor", content });

        let agentEl;
        let agentText = "";
        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId, content, history: history.slice(-HISTORY_MAX) }),
            });
            if (!res.ok || !res.body) {
                const msg = res.status === 429 ? "You're sending messages too fast — please slow down." : "Sorry, something went wrong.";
                addMsg("note", msg);
                return;
            }
            await readSSE(res.body, (event, data) => {
                if (event === "delta") {
                    if (!agentEl) agentEl = addMsg("agent", "");
                    agentText += data;
                    agentEl.textContent = agentText;
                    log.scrollTop = log.scrollHeight;
                } else if (event === "pending") {
                    addMsg("note", data);
                } else if (event === "error") {
                    addMsg("note", data || "Sorry, something went wrong.");
                }
            });
            if (agentText) history.push({ author: "agent", content: agentText });
        } catch {
            addMsg("note", "Couldn't reach support. Please try again.");
        } finally {
            busy = false;
            sendBtn.disabled = false;
            input.focus();
        }
    };

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send();
    });
})();
