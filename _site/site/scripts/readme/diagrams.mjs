// The README's drawn figures, for the parts of the story no single screen shows: how a task moves, where each piece
// runs, and which AI plans it runs on. Plain HTML in the site's carved vocabulary; compose.mjs supplies the tokens,
// the fonts and the ornaments, and renders each one for both looks.
import { LOTUS, LOZENGE, corners, providerMark } from "./art.mjs";

// Line icons on a 24 grid, stroked in currentColor.
const icon = (body) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
    ask: icon(
        `<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/><path d="M8 9h8M8 12h5"/>`,
    ),
    plan: icon(`<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11"/><circle cx="5" cy="18" r="1.3"/>`),
    branches: icon(
        `<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="18" cy="16" r="2"/><path d="M6 7v10M6 13c0-3 2-5 5-5h5M6 13c0 2 2 3 5 3h5"/>`,
    ),
    away: icon(
        `<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/><path d="M14.5 8.2a2.6 2.6 0 1 1-3.1-3.1 2 2 0 0 0 3.1 3.1z"/>`,
    ),
    land: icon(
        `<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M6 8c0 3 3 4 6 4h4"/>`,
    ),
    browser: icon(
        `<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 8.5h18"/><circle cx="6" cy="6.5" r=".4" fill="currentColor"/><circle cx="8" cy="6.5" r=".4" fill="currentColor"/>`,
    ),
    desktop: icon(`<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>`),
    phone: icon(`<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>`),
    terminal: icon(`<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="m7 10 3 2.5L7 15M12.5 15H17"/>`),
    globe: icon(
        `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.5 5.2 3.5 8.5s-1 6.2-3.5 8.5c-2.5-2.3-3.5-5.2-3.5-8.5s1-6.2 3.5-8.5z"/>`,
    ),
    plug: icon(`<path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 0 1-10 0zM12 15v6"/>`),
    search: icon(`<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>`),
    key: icon(`<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>`),
    repo: icon(
        `<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7h6"/>`,
    ),
    shield: icon(`<path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z"/><path d="m9 12 2 2 4-4"/>`),
};

const SHARED = `
.panel { position: relative; background: var(--panel); border: 1px solid var(--line-strong); }
.panel::before { content: ""; position: absolute; inset: 5px; border: 1px solid var(--line); pointer-events: none; }
.eyebrow { font: 600 12px/1 "Public Sans"; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); }
.mono { font-family: "JetBrains Mono", monospace; }
.ico { width: 22px; height: 22px; color: var(--ember-ink); flex: none; }
.ico svg { display: block; width: 100%; height: 100%; }
.loz { display: inline-block; width: 12px; height: 12px; color: var(--gold); }
.loz svg { display: block; width: 100%; height: 100%; }
`;

// HOW A TASK MOVES: five steps, one line each, joined by the site's lozenge rule.
const flow = {
    name: "flow",
    selector: ".pad",
    css: () => `${SHARED}
      .pad { padding: 16px 20px 28px; display: inline-block; }
      .panel { width: 1000px; padding: 40px 26px 30px; }
      .steps { display: grid; grid-template-columns: repeat(5, 1fr); position: relative; }
      .rule { position: absolute; left: 10%; right: 10%; top: 31px; height: 1px;
        background: linear-gradient(90deg, transparent, var(--line-bright) 8%, var(--line-bright) 92%, transparent); }
      .step { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 6px; }
      .medal { position: relative; width: 62px; height: 62px; display: grid; place-items: center; transform: rotate(45deg);
        background: var(--card); border: 1px solid var(--line-bright); box-shadow: var(--glow); margin-bottom: 26px; }
      .medal > * { transform: rotate(-45deg); }
      .medal .ico { width: 26px; height: 26px; }
      .num { position: absolute; top: -12px; right: -12px; transform: rotate(-45deg); width: 24px; height: 24px; border-radius: 50%;
        display: grid; place-items: center; background: var(--ember); color: #fff; font: 700 12px/1 "Public Sans"; }
      .t { font: 400 21px/1.15 "Spectral", serif; white-space: nowrap; color: var(--ink); margin-bottom: 9px; }
      .d { font: 400 15px/1.45 "Public Sans"; color: var(--muted); max-width: 180px; }
      .d b { color: var(--ink); font-weight: 600; }
      .foot { margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line); display: flex; justify-content: center; gap: 26px;
        font: 500 14.5px/1 "Public Sans"; color: var(--subtle); }
      .foot span { display: inline-flex; align-items: center; gap: 9px; }`,
    html: () => {
        const steps = [
            ["ask", "Describe it", "Pick the agent: <b>Claude Code, Codex, Cursor</b> or another."],
            ["plan", "Approve the plan", "It reads the code and proposes. <b>Nothing changes</b> until you say yes."],
            ["branches", "Run in parallel", "Each agent on its <b>own git worktree</b> and branch. Run ten at once."],
            ["away", "Walk away", "Close the browser. <b>Runs keep going.</b> Check in from your phone."],
            ["land", "Review, then land", "Read <b>every diff</b>. Land it on your branch, or discard it."],
        ];
        return `<div class="pad"><div class="panel">${corners()}
          <div class="steps"><div class="rule"></div>${steps
              .map(
                  ([key, title, text], index) =>
                      `<div class="step"><div class="medal"><span class="ico">${ICONS[key]}</span><span class="num">${index + 1}</span></div><div class="t">${title}</div><div class="d">${text}</div></div>`,
              )
              .join("")}</div>
          <div class="foot"><span><i class="loz">${LOZENGE}</i>Your machine</span><span><i class="loz">${LOZENGE}</i>Your AI subscriptions</span><span><i class="loz">${LOZENGE}</i>Your review before anything lands</span></div>
        </div></div>`;
    },
};

// WHERE EACH PIECE RUNS: windows anywhere, the sandbox on your machine, and the platform off to the side.
const architecture = {
    name: "architecture",
    selector: ".pad",
    css: () => `${SHARED}
      .pad { padding: 16px 20px 28px; display: inline-block; }
      .panel { width: 1000px; padding: 30px 28px 24px; }
      .grid { display: grid; grid-template-columns: 196px 96px 1fr; align-items: stretch; }
      .col-title { margin-bottom: 16px; }
      .devices { display: flex; flex-direction: column; gap: 12px; padding-top: 2px; }
      .device { display: flex; align-items: center; gap: 12px; padding: 13px 13px; background: var(--card); border: 1px solid var(--line-strong); }
      .device .n { font: 600 16px/1.2 "Public Sans"; }
      .device .s { font: 400 13.5px/1.3 "Public Sans"; color: var(--muted); margin-top: 3px; }
      .tunnel { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 0 8px; }
      .pipe { position: relative; width: 100%; height: 12px; }
      .pipe::before { content: ""; position: absolute; left: 4px; right: 4px; top: 5px; height: 2px;
        background: repeating-linear-gradient(90deg, var(--ember) 0 10px, transparent 10px 16px); }
      .pipe::after { content: ""; position: absolute; right: 0; top: 1px; border: 5px solid transparent; border-left: 8px solid var(--ember); }
      .tl1 { font: 600 12px/1.2 "Public Sans"; letter-spacing: .14em; text-transform: uppercase; color: var(--ember-ink); text-align: center; }
      .tl2 { font: 400 12.5px/1.35 "Public Sans"; color: var(--muted); text-align: center; }
      .machine { position: relative; border: 1px solid var(--line-bright); background: var(--window); padding: 18px 16px 16px; }
      .machine-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
      .machine-head .s { font: 400 13.5px/1 "Public Sans"; color: var(--muted); }
      .sandbox { position: relative; border: 1px dashed var(--line-bright); background: var(--ember-wash); padding: 14px 12px 12px; }
      .sandbox-head { display: flex; align-items: center; gap: 10px; margin-bottom: 13px; }
      .sandbox-head .n { font: 400 21px/1 "Spectral", serif; }
      .sandbox-head .s { font: 400 13.5px/1 "Public Sans"; color: var(--muted); }
      .agents { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      .agent { background: var(--card); border: 1px solid var(--line-strong); padding: 10px 10px; }
      .agent .top { display: flex; align-items: center; gap: 7px; font: 600 14.5px/1 "Public Sans"; white-space: nowrap; }
      .agent .mark { width: 17px; height: 17px; color: var(--ink); }
      .agent .mark svg { display: block; width: 100%; height: 100%; }
      .agent .br { margin-top: 8px; font: 400 11.5px/1 "JetBrains Mono"; color: var(--subtle); white-space: nowrap; }
      .agent .st { margin-top: 8px; font: 500 12.5px/1 "Public Sans"; }
      .tools { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .tool { display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; border: 1px solid var(--line); background: var(--card);
        font: 500 13px/1 "Public Sans"; color: var(--muted); }
      .tool .ico { width: 15px; height: 15px; color: var(--gold); }
      .landing { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
      .arrow { font: 500 13.5px/1 "Public Sans"; color: var(--ember-ink); display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
      .repo { flex: 1; display: flex; align-items: center; gap: 10px; padding: 11px 14px; border: 1px solid var(--line-strong); background: var(--card);
        font: 600 14.5px/1 "Public Sans"; }
      .repo .s { font: 400 13px/1 "Public Sans"; color: var(--muted); margin-left: auto; }
      .platform { display: flex; align-items: center; gap: 12px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line);
        font: 400 14.5px/1.4 "Public Sans"; color: var(--muted); }
      .platform b { color: var(--ink); font-weight: 600; }
      .platform .lotus { width: 22px; height: 22px; flex: none; }`,
    html: () => {
        const devices = [
            ["browser", "Any browser", "on any computer"],
            ["desktop", "Desktop app", "Windows and Linux"],
            ["phone", "Your phone", "the same board"],
        ];
        const agents = [
            ["claude", "Claude Code", "agent/checkout", "Waiting for you", "var(--ember-ink)"],
            ["codex", "Codex", "agent/flaky-test", "Working", "var(--muted)"],
            ["cursor", "Cursor", "agent/soft-deletes", "Ready to land", "var(--ok)"],
            ["gemini", "Gemini", "agent/release-notes", "Working", "var(--muted)"],
        ];
        const tools = [
            ["terminal", "Terminals"],
            ["globe", "Browsers"],
            ["plug", "MCP servers"],
            ["search", "Code search"],
            ["key", "Secrets"],
        ];
        return `<div class="pad"><div class="panel">${corners()}
          <div class="grid">
            <div><div class="eyebrow col-title">You, anywhere</div><div class="devices">${devices
                .map(
                    ([key, name, sub]) =>
                        `<div class="device"><span class="ico">${ICONS[key]}</span><div><div class="n">${name}</div><div class="s">${sub}</div></div></div>`,
                )
                .join("")}</div></div>
            <div class="tunnel"><div class="tl1">Private tunnel</div><div class="pipe"></div><div class="tl2">dials out<br>no open ports</div></div>
            <div class="machine">${corners()}
              <div class="machine-head"><span class="eyebrow">Your machine</span><span class="s">laptop, desktop or server</span></div>
              <div class="sandbox">
                <div class="sandbox-head"><span class="ico">${ICONS.shield}</span><span class="n">Sandbox</span><span class="s">a Docker container that keeps running when you leave</span></div>
                <div class="agents">${agents
                    .map(
                        ([brand, name, branch, state, colour]) =>
                            `<div class="agent"><div class="top"><span class="mark">${providerMark(brand)}</span>${name}</div><div class="br">${branch}</div><div class="st" style="color:${colour}">${state}</div></div>`,
                    )
                    .join("")}</div>
                <div class="tools">${tools.map(([key, label]) => `<span class="tool"><span class="ico">${ICONS[key]}</span>${label}</span>`).join("")}</div>
              </div>
              <div class="landing"><span class="arrow">you read the diff, then land&nbsp;→</span><div class="repo"><span class="ico">${ICONS.repo}</span>Your repositories<span class="s">plain git, on your disk</span></div></div>
            </div>
          </div>
          <div class="platform"><span class="lotus">${LOTUS}</span><span><b>intentic.dev</b> keeps your sign-in and your sandbox's address. Your code, prompts and keys never leave your machine.</span></div>
        </div></div>`;
    },
};

// THE AI PLANS IT RUNS ON: the providers the agent picker offers, each on the plan you already pay for.
const providers = {
    name: "providers",
    selector: ".pad",
    css: () => `${SHARED}
      .pad { padding: 16px 20px 28px; display: inline-block; }
      .panel { width: 1000px; padding: 28px 26px 24px; }
      .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
      .tile { display: flex; align-items: center; gap: 12px; padding: 14px 13px; background: var(--card); border: 1px solid var(--line-strong); }
      .tile .mark { width: 30px; height: 30px; color: var(--ink); flex: none; }
      .tile .mark svg { display: block; width: 100%; height: 100%; }
      .tile .n { font: 600 16px/1.15 "Public Sans"; white-space: nowrap; }
      .tile .s { font: 400 13.5px/1.25 "Public Sans"; white-space: nowrap; color: var(--muted); margin-top: 4px; }
      .tile.any { border-style: dashed; border-color: var(--line-bright); background: var(--ember-wash); }
      .tile.any .mark { color: var(--ember-ink); }
      .note { display: flex; justify-content: center; gap: 28px; margin-top: 20px; font: 500 14.5px/1 "Public Sans"; color: var(--muted); }
      .note span { display: inline-flex; align-items: center; gap: 9px; }`,
    html: () => {
        const tiles = [
            ["claude", "Claude Code", "Pro or Max plan"],
            ["codex", "Codex", "ChatGPT plan"],
            ["cursor", "Cursor", "Cursor Pro"],
            ["gemini", "Gemini", "Google sign-in"],
            ["grok", "Grok", "SuperGrok"],
            ["kimi", "Kimi Code", "Membership"],
            ["zai", "GLM", "Z.ai Coding Plan"],
            ["meta", "Meta", "Model API key"],
        ];
        const any = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>`;
        return `<div class="pad"><div class="panel">${corners()}
          <div class="tiles">${tiles
              .map(
                  ([brand, name, plan]) =>
                      `<div class="tile"><span class="mark">${providerMark(brand)}</span><div><div class="n">${name}</div><div class="s">${plan}</div></div></div>`,
              )
              .join("")}
            <div class="tile any"><span class="mark">${any}</span><div><div class="n">ACP agents</div><div class="s">OpenCode and more</div></div></div>
            <div class="tile any"><span class="mark">${icon(`<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/><path d="M9 1.5v2.5M15 1.5v2.5M9 20v2.5M15 20v2.5M1.5 9H4M1.5 15H4M20 9h2.5M20 15h2.5"/>`)}</span><div><div class="n">Local models</div><div class="s">llama.cpp, any API</div></div></div>
          </div>
          <div class="note"><span><i class="loz">${LOZENGE}</i>No token markup</span><span><i class="loz">${LOZENGE}</i>Runs on your machine</span><span><i class="loz">${LOZENGE}</i>Several accounts per provider</span></div>
        </div></div>`;
    },
};

export const DIAGRAMS = [flow, architecture, providers];
