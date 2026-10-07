// What a page the agent shows in the chat is sealed and styled with, spelled once for both places that draw one: the
// daemon's headless check (agent/pages/page-check.ts), which lays the page out the way the chat will, and the chat's
// own frame (the editor's chat/transcript/pages). A page runs its scripts in a frame with an opaque origin and no
// network: the policy below is the whole of what it may load, and the bootstrap is the whole of what it may say.

// Everything a sealed page may load is already inside it: its own inline scripts and styles, and pictures, fonts and
// media carried in as data. Nothing reaches the network, another frame, or a form target.
export const SEALED_PAGE_POLICY = [
    `default-src 'none'`,
    // Inline only, which is every script a sealed document can hold. Eval gives nothing more to a frame that can reach
    // nothing.
    `script-src 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'unsafe-inline'`,
    `img-src data: blob:`,
    `font-src data:`,
    `media-src data: blob:`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `worker-src 'none'`,
    `object-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `manifest-src 'none'`,
].join(`; `);

// The bridge between a page and the chat around it speaks the MCP Apps extension's own JSON-RPC over postMessage
// (io.modelcontextprotocol/ui), so one host serves both the agent's pages and an MCP server's app. `submit` is this
// product's own: the answer an `ask_page` page sends back.
export const PAGE_BRIDGE = {
    initialize: `ui/initialize`,
    toolsCall: `tools/call`,
    updateModelContext: `ui/update-model-context`,
    requestDisplayMode: `ui/request-display-mode`,
    initialized: `ui/notifications/initialized`,
    sizeChanged: `ui/notifications/size-changed`,
    hostContextChanged: `ui/notifications/host-context-changed`,
    toolInput: `ui/notifications/tool-input`,
    toolResult: `ui/notifications/tool-result`,
    openLink: `ui/open-link`,
    message: `ui/message`,
    submit: `intentic/submit`,
    // An uncaught error in the page's own scripts, told as it happens: the chat hands it to the agent that showed the
    // page while its turn still runs, and offers the reader the ask afterwards.
    error: `intentic/page-error`,
} as const;

// How many distinct errors a page tells, and how long each may be: enough to fix it by, never a flood.
export const PAGE_ERRORS_MAX = 10;
export const PAGE_ERROR_CHARS = 600;

// The width the chat's reply column usually is, which the check lays a page out at and measures it by.
export const PAGE_COLUMN_WIDTH = 720;

export type PageAppearance = "dark" | "light";

// The variables a page styles against, as the chat resolves them from its own look (and follows it as it changes).
export const PAGE_THEME_VARIABLES = [
    `--background`,
    `--foreground`,
    `--card`,
    `--card-foreground`,
    `--muted`,
    `--muted-foreground`,
    `--border`,
    `--input`,
    `--ring`,
    `--primary`,
    `--primary-foreground`,
    `--accent`,
    `--accent-foreground`,
    `--success`,
    `--warning`,
    `--danger`,
    `--info`,
    `--chart-1`,
    `--chart-2`,
    `--chart-3`,
    `--chart-4`,
    `--chart-5`,
    `--code-background`,
    `--radius`,
    `--font-sans`,
    `--font-mono`,
] as const;
export type PageThemeVariable = (typeof PAGE_THEME_VARIABLES)[number];

export interface PageTheme {
    readonly appearance: PageAppearance;
    readonly variables: Readonly<Record<PageThemeVariable, string>>;
}

const FONTS = {
    "--font-sans": `"Public Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
    "--font-mono": `"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`,
    "--radius": `8px`,
} as const;

// The chat's two looks as fixed colours, close to the editor's own warm roles: what a page wears where nothing live can
// say (the daemon's headless check, a page opened on its own), and what the chat starts from before it reads its own.
export const PAGE_FALLBACK_THEMES: Readonly<Record<PageAppearance, PageTheme>> = {
    dark: {
        appearance: `dark`,
        variables: {
            "--background": `#14110e`,
            "--foreground": `#e9e1d3`,
            "--card": `#1d1915`,
            "--card-foreground": `#e9e1d3`,
            "--muted": `#2a241e`,
            "--muted-foreground": `#a59885`,
            "--border": `#2e2822`,
            "--input": `#3a332b`,
            "--ring": `#e2a65a`,
            "--primary": `#e2a65a`,
            "--primary-foreground": `#1a140e`,
            "--accent": `#e2a65a`,
            "--accent-foreground": `#1a140e`,
            "--success": `#4fbf7a`,
            "--warning": `#e3b341`,
            "--danger": `#ef7a62`,
            "--info": `#6aa8ef`,
            "--chart-1": `#e2a65a`,
            "--chart-2": `#5fb3a8`,
            "--chart-3": `#a98be6`,
            "--chart-4": `#ef7a8a`,
            "--chart-5": `#9cc75a`,
            "--code-background": `#1d1915`,
            ...FONTS,
        },
    },
    light: {
        appearance: `light`,
        variables: {
            "--background": `#f4efe7`,
            "--foreground": `#2b2119`,
            "--card": `#fdfaf5`,
            "--card-foreground": `#2b2119`,
            "--muted": `#ece5da`,
            "--muted-foreground": `#6b5c4d`,
            "--border": `#e2d9cc`,
            "--input": `#d6cbbb`,
            "--ring": `#a3591a`,
            "--primary": `#b8651d`,
            "--primary-foreground": `#ffffff`,
            "--accent": `#a3591a`,
            "--accent-foreground": `#ffffff`,
            "--success": `#1f7a43`,
            "--warning": `#8a5a00`,
            "--danger": `#b42f1e`,
            "--info": `#1f5fa8`,
            "--chart-1": `#b8651d`,
            "--chart-2": `#1f8a7e`,
            "--chart-3": `#6e4fc2`,
            "--chart-4": `#c2405a`,
            "--chart-5": `#5a8a1f`,
            "--code-background": `#f7f2ea`,
            ...FONTS,
        },
    },
};

// What a tool description tells the agent about the variables, spelled from the list above.
export const PAGE_THEME_GUIDE =
    `The chat hands the page its live theme as CSS custom properties on :root, and they follow the reader's light/dark ` +
    `switch while the page is open: ${PAGE_THEME_VARIABLES.join(`, `)}. --background is the conversation's own ` +
    `background; --chart-1 … --chart-5 are a categorical series that reads in both looks. Style with these instead of ` +
    `fixed colours, so the page looks like part of the chat in either look. CSS and SVG styled with var(--…) follow a ` +
    `switch by themselves; a canvas, or a chart library handed colours as values, does not: read them with ` +
    `getComputedStyle(document.documentElement) and draw again on the document's \`intentic:theme\` event.`;

// How a page sits in a reply, for the same description.
export const PAGE_LAYOUT_GUIDE =
    `The page is drawn inline in the reply column (about ${PAGE_COLUMN_WIDTH}px wide on a desktop, about 360px on a phone), ` +
    `borderless, on the conversation's own background: leave html and body without a background, use a fluid width, and ` +
    `add no outer card, border or page title of your own, since the page is part of your reply. Let the content set the ` +
    `height (no 100vh on html or body): the frame grows to fit. Give charts fixed pixel heights. Size anything you draw ` +
    `from its container's width when you draw it, and draw again when that width changes (a ResizeObserver on the ` +
    `container): the column narrows on a phone and when a side panel opens, so a width read once at load goes stale.`;

// The base every page starts from: the theme's colours and fonts (native controls in the accent too), no margin, no
// scrollbar (the frame fits the page).
// `canvas` paints the page's own background, for where there is no conversation behind it (a check, a download).
const baseCss = (canvas: boolean): string =>
    `html{${canvas ? `background:var(--background);` : `background:transparent;`}color:var(--foreground);font-family:var(--font-sans);` +
    `font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none;accent-color:var(--primary)}` +
    `html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}`;

// The theme as one `:root` rule; a value can hold nothing that ends the rule.
export const pageThemeCss = (theme: PageTheme, canvas = false): string =>
    `:root{color-scheme:${theme.appearance};${PAGE_THEME_VARIABLES.map((name) => `${name}:${theme.variables[name].replace(/[;{}<>]/g, ``)};`).join(``)}}${baseCss(canvas)}`;

// The page's half of the bridge, run first in its head: the theme it starts in and every change the chat posts, the
// height it needs whenever that changes, and `window.intentic` for the page's own scripts (submit an answer, send the
// chat a message, open a link). Every request is answered by the chat, which alone decides whether to act on it.
const bootstrapScript = (canvas: boolean): string => `(function(){
var style=document.getElementById("intentic-theme"),n=0,pending={},theme=null,canvas=${canvas ? `true` : `false`};
var names=${JSON.stringify(PAGE_THEME_VARIABLES)};
function apply(t){if(!t||typeof t!=="object"||!t.variables)return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var i=0;i<names.length;i++){var v=t.variables[names[i]];if(typeof v==="string")c+=names[i]+":"+v.replace(/[;{}<>]/g,"")+";";}c+="}";if(style)style.textContent=c+${JSON.stringify(baseCss(false))}.replace("background:transparent;",canvas?"background:var(--background);":"background:transparent;");theme={appearance:t.appearance==="light"?"light":"dark",variables:t.variables};document.dispatchEvent(new CustomEvent("intentic:theme",{detail:theme}));}
var framed=window.parent!==window;
function post(m){if(framed)window.parent.postMessage(m,"*");}
var told={},faults=0;function fault(t){t=String(t).slice(0,${PAGE_ERROR_CHARS});if(told[t]||faults>=${PAGE_ERRORS_MAX})return;told[t]=1;faults++;post({jsonrpc:"2.0",method:${JSON.stringify(PAGE_BRIDGE.error)},params:{message:t}});}
function said(x,fallback){return x&&typeof x.stack==="string"?x.stack.split("\\n").slice(0,2).map(function(l){return l.trim();}).join(" "):fallback;}
window.addEventListener("error",function(e){if(e instanceof ErrorEvent)fault(said(e.error,(e.message||"Script error")+(e.lineno?" (line "+e.lineno+")":"")));});
window.addEventListener("unhandledrejection",function(e){fault("Unhandled rejection: "+said(e.reason,String(e.reason)));});
function request(method,params){return new Promise(function(resolve,reject){if(!framed){reject(new Error("This page is not inside a chat."));return;}var id="intentic-"+(++n);pending[id]={resolve:resolve,reject:reject};post({jsonrpc:"2.0",id:id,method:method,params:params});});}
window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.jsonrpc!=="2.0")return;if(d.method===${JSON.stringify(PAGE_BRIDGE.hostContextChanged)}&&d.params){apply({appearance:d.params.theme,variables:d.params.styles&&d.params.styles.variables});return;}if(d.id!==undefined&&pending[d.id]){var p=pending[d.id];delete pending[d.id];if(d.error)p.reject(new Error(String(d.error.message||"Refused")));else p.resolve(d.result);}});
if(framed){var h=-1,z=function(){var r=document.documentElement,b=document.body,v=Math.ceil(Math.max(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height,b?b.getBoundingClientRect().bottom:0));if(v===h||v<=0)return;h=v;post({jsonrpc:"2.0",method:${JSON.stringify(PAGE_BRIDGE.sizeChanged)},params:{height:v}});};if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);z();});}window.addEventListener("load",z);setTimeout(z,50);}
window.intentic={
submit:function(value){return request(${JSON.stringify(PAGE_BRIDGE.submit)},{value:value===undefined?null:JSON.parse(JSON.stringify(value))});},
send:function(text){return request(${JSON.stringify(PAGE_BRIDGE.message)},{role:"user",content:[{type:"text",text:String(text)}]});},
openLink:function(url){return request(${JSON.stringify(PAGE_BRIDGE.openLink)},{url:String(url)});},
get theme(){return theme;}
};
})();`;

// The page's head opening: its theme, then the bootstrap, ahead of anything the page writes itself, so the first paint
// already wears the theme and a page's own `:root` rules still win.
export const pageHead = (theme: PageTheme, options: { readonly canvas?: boolean } = {}): string => {
    const canvas = options.canvas === true;
    return (
        `<style id="intentic-theme">${pageThemeCss(theme, canvas)}</style>` +
        // The bootstrap, holding the theme it starts from as `intentic.theme`; `<` escaped so the JSON cannot end the script.
        `<script>${bootstrapScript(canvas).replace(`theme=null`, `theme=${JSON.stringify(theme).replace(/</g, `\\u003c`)}`)}</script>`
    );
};

// A sandboxed frame has an opaque origin, so it often runs in a process of its own and learns its size a beat after its
// document starts: through parse, DOMContentLoaded and load it is 0×0, and a page that measures itself as it loads (a
// chart sizing its SVG from clientWidth) draws into nothing and stays that way. Knowing its width is not enough either:
// until the frame's first rendering pass, innerWidth can already say 720 while every box still measures 0 (Chromium
// did so in about half of a few dozen runs, in-process frames included). So this shell holds the page until the frame
// has rendered at a width (its first resize, or the first animation frame that finds one), then writes it into itself,
// so the page's first script already sees the size it is drawn at. Only for a frame that runs scripts: in one that does
// not, the shell would be all there is. The chat's frame and the file viewer draw a page through it, and the daemon's
// check lays one out through it, so all three see the same start.
export const sizedFirst = (html: string): string =>
    `<!DOCTYPE html><script>(function(){var page=${JSON.stringify(html).replace(/</g, `\\u003c`)},done=false;` +
    `function go(){if(done||window.innerWidth===0)return;done=true;removeEventListener("resize",go);` +
    `document.open();document.write(page);document.close();}addEventListener("resize",go);` +
    `function frame(){if(!done){go();if(!done)requestAnimationFrame(frame);}}requestAnimationFrame(frame);})()</script>`;

// Where in a document its head's contents begin: just inside `<head>`, else a head made for it. Only the opening of the
// document is scanned, and a comment or script holding something tag-shaped there is skipped over.
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

// Blanks comments and raw-text elements to the same length, so a tag written inside one is never taken for the real one.
const blanked = (html: string): string =>
    html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, (match) => ` `.repeat(match.length));

// `inner` placed first inside the document's head, making the head (and the html) where the page wrote none.
export const intoHead = (html: string, inner: string): string => {
    const scan = blanked(html);
    const head = HEAD_OPEN.exec(scan);
    if (head !== null) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + inner + html.slice(at);
    }
    const root = HTML_OPEN.exec(scan);
    if (root !== null) {
        const at = root.index + root[0].length;
        return `${html.slice(0, at)}<head>${inner}</head>${html.slice(at)}`;
    }
    const doctype = DOCTYPE.exec(html);
    if (doctype !== null) {
        const at = doctype[0].length;
        return `${html.slice(0, at)}<head>${inner}</head>${html.slice(at)}`;
    }
    return `<!doctype html><head>${inner}</head>${html}`;
};

// A page sealed whole, as a string: the policy first, then the theme and bootstrap. What the daemon's check renders, and
// what a page opened on its own (a download, the outbox) carries, with `canvas` painting its own background there.
export const sealedPage = (html: string, theme: PageTheme, options: { readonly canvas?: boolean; readonly policy?: boolean } = {}): string =>
    intoHead(
        html,
        `${options.policy === false ? `` : `<meta http-equiv="Content-Security-Policy" content="${SEALED_PAGE_POLICY}">`}` +
            `<meta name="referrer" content="no-referrer">${pageHead(theme, options)}`,
    );

// The theme a stored page carries for being opened on its own (the outbox, a download, the file viewer), at no
// specificity at all (`:where`), so the chat's live theme and every rule the page writes itself win over it wherever
// either is present. Follows the OS's own light or dark.
const variablesCss = (theme: PageTheme): string =>
    `color-scheme:${theme.appearance};${PAGE_THEME_VARIABLES.map((name) => `${name}:${theme.variables[name]};`).join(``)}`;
export const pageDefaultsCss = (): string =>
    `:where(:root){${variablesCss(PAGE_FALLBACK_THEMES.dark)}}` +
    `@media (prefers-color-scheme: light){:where(:root){${variablesCss(PAGE_FALLBACK_THEMES.light)}}}` +
    `:where(html){background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;accent-color:var(--primary)}` +
    `:where(body){margin:0}:where(.intentic-standalone) :where(body){padding:16px}`;

// What `window.intentic` does where no chat is around the page: a link opens, an answer has nowhere to go and says so.
const STANDALONE_SCRIPT =
    `if(window.parent===window)document.documentElement.classList.add("intentic-standalone");` +
    `if(!window.intentic){window.intentic={theme:null,` +
    `openLink:function(u){window.open(String(u),"_blank","noopener");return Promise.resolve();},` +
    `submit:function(){return Promise.reject(new Error("This page is not inside a chat."));},` +
    `send:function(){return Promise.reject(new Error("This page is not inside a chat."));}};}`;

// A page as it is stored: what the agent wrote, carried, with defaults that make it whole on its own. Inside the chat
// the frame's own theme and bootstrap come first and win (pageHead), so the stored file is drawn exactly as written.
export const standalonePage = (html: string): string =>
    intoHead(html, `<style id="intentic-page-defaults">${pageDefaultsCss()}</style><script>${STANDALONE_SCRIPT}</script>`);

// A stored page as a published conversation carries it (share-publish.ts): sealed off the network, and saying its own
// height to the page around it, in the bridge's own words, so the shared transcript fits its frame. It keeps the theme
// it was stored with (standalonePage), which follows the reader's light or dark.
const SIZE_SCRIPT =
    `(function(){if(window.parent===window)return;var h=-1;function z(){var r=document.documentElement,b=document.body,` +
    `v=Math.ceil(Math.max(r.getBoundingClientRect().height,b?b.getBoundingClientRect().bottom:0));if(v===h||v<=0)return;h=v;` +
    `window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(PAGE_BRIDGE.sizeChanged)},params:{height:v}},"*");}` +
    `if(window.ResizeObserver)new ResizeObserver(z).observe(document.documentElement);window.addEventListener("load",z);setTimeout(z,50);})();`;
export const publishedPage = (stored: string): string =>
    intoHead(stored, `<meta http-equiv="Content-Security-Policy" content="${SEALED_PAGE_POLICY}"><meta name="referrer" content="no-referrer"><script>${SIZE_SCRIPT}</script>`);

// What an MCP server's app is shown with (agent/pages/mcp-apps.ts): the call's arguments and its result, kept inside the
// stored page as a data block the chat hands the app over the bridge (`tool-input`, `tool-result`) once it is ready.
export const MCP_APP_DATA_ID = `intentic-mcp-app`;
export interface McpAppData {
    readonly server: string;
    readonly tool: string;
    readonly input: unknown;
    readonly result: unknown;
}
export const mcpAppDataScript = (data: McpAppData): string =>
    `<script type="application/json" id="${MCP_APP_DATA_ID}">${JSON.stringify(data).replace(/</g, `\\u003c`)}</script>`;
const MCP_APP_DATA_BLOCK = new RegExp(`<script type="application/json" id="${MCP_APP_DATA_ID}">([\\s\\S]*?)</script>`);
// Read back out of a stored page's text; undefined for a page that is not an app's, or a block that does not parse.
export const readMcpAppData = (html: string): McpAppData | undefined => {
    const match = MCP_APP_DATA_BLOCK.exec(html);
    if (match === null) {
        return undefined;
    }
    try {
        const data = JSON.parse(match[1] ?? ``) as Partial<McpAppData>;
        return typeof data.server === `string` && typeof data.tool === `string` ? { server: data.server, tool: data.tool, input: data.input, result: data.result } : undefined;
    } catch {
        // allow(silent-catch): a block that does not parse is not an app's, as the comment on this function says.
        return undefined;
    }
};

// A page's answer as the agent is handed it: JSON text, whatever the page sent, refused past the cap rather than cut.
export const pageValueText = (value: unknown): string => JSON.stringify(value === undefined ? null : value) ?? `null`;
