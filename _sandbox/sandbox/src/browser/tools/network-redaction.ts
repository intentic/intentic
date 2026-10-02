import { z } from "zod";
import { maskCredentialMaterial } from "@intentic/sandbox-contract";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";

// What the router does to @playwright/mcp's two network tools before their answer reaches the transcript. Upstream
// prints a request's full URL, every header Playwright keeps (it drops cookies, but not Authorization, x-api-key or a
// CSRF token) and, with `part`, the raw bodies: the bearer token a site issued, an OAuth code in a redirect, token JSON.
// None of those is a stored secret, so the exact-value masking in agent-redaction.ts cannot know them. Applied to every
// owner, the anonymous `web` browser included: it holds no saved profile, but a turn can sign it in with
// type_secret, whose point is that the model never sees the credential, and the session token it yields is one.
// What survives is what a request is debugged by: method, status, host and path, parameter names, content-type and the
// headers on the list below. What does not: header values off the list, every query value, the fragment, URL userinfo,
// and credential-shaped values inside a body (maskCredentialMaterial, plus every value of a form-encoded body).

// The call as far as the router needs it: which network tool, which part, and whether it asked for a file. Parsed
// rather than read off the params, so any other tool (or a malformed call) is simply not a network call.
const NetworkCallSchema = z.object({
    name: z.enum(["browser_network_requests", "browser_network_request"]),
    arguments: z.looseObject({
        part: z.enum(["request-headers", "request-body", "response-headers", "response-body"]).optional(),
        filename: z.string().optional(),
    }),
});
export type NetworkCall = z.infer<typeof NetworkCallSchema>;

export const networkCallOf = (params: RpcMessage["params"]): NetworkCall | undefined => NetworkCallSchema.safeParse(params).data;

// Only text blocks are read; any other block (an image, a resource link) passes as it came.
const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
const AnswerSchema = z.looseObject({ content: z.array(z.unknown()) });

const MASK = "***";

// Allowed by name, not denied by pattern: a site names its own credential headers (x-guest-token, x-ig-www-claim), and
// a list of names that are safe cannot be outrun by one nobody thought of. A header off it keeps its name, so the model
// still learns it was sent.
const SAFE_HEADERS: ReadonlySet<string> = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "accept-ranges",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-expose-headers",
    "access-control-max-age",
    "access-control-request-headers",
    "access-control-request-method",
    "age",
    "allow",
    "cache-control",
    "connection",
    "content-disposition",
    "content-encoding",
    "content-language",
    "content-length",
    "content-type",
    "date",
    "etag",
    "expires",
    "host",
    "if-modified-since",
    "if-none-match",
    "keep-alive",
    "last-modified",
    "location",
    "origin",
    "pragma",
    "priority",
    "referer",
    "retry-after",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "server",
    "strict-transport-security",
    "transfer-encoding",
    "upgrade-insecure-requests",
    "user-agent",
    "vary",
    "via",
    "x-content-type-options",
    "x-frame-options",
    "x-powered-by",
    "x-requested-with",
]);

// Every query value, not the credential-looking ones: a magic link's token rides under whatever name the site chose
// (`t`, `oobCode`, `confirmation_token`), and a name list would be the same losing race as a header denylist.
const maskQuery = (query: string): string =>
    query
        .split("&")
        .map((pair) => {
            const at = pair.indexOf("=");
            return at === -1 || at === pair.length - 1 ? pair : `${pair.slice(0, at + 1)}${MASK}`;
        })
        .join("&");

// String surgery rather than `new URL().href`, which would re-encode and re-slash the parts it keeps.
const sanitizeUrl = (url: string): string => {
    const hash = url.indexOf("#");
    const withoutFragment = hash === -1 ? url : url.slice(0, hash);
    const question = withoutFragment.indexOf("?");
    const base = (question === -1 ? withoutFragment : withoutFragment.slice(0, question)).replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@?#\s]*@/i, "$1");
    return question === -1 ? base : `${base}?${maskQuery(withoutFragment.slice(question + 1))}`;
};

// Stops at whitespace, quotes and brackets, which is where a URL ends in the list line, a header value and JSON alike.
// Captured, so split() hands back the URLs at the odd indices.
const URL_IN_TEXT = /(\b(?:https?|wss?):\/\/[^\s<>"'`]+)/i;

// URLs and the text between them take different passes: maskCredentialMaterial's bare-value arm reads up to the next
// space, so run over a sanitized `access_token=***&page=***` it would swallow every parameter after the first.
const sanitizeText = (text: string): string =>
    text
        .split(URL_IN_TEXT)
        .map((piece, index) => (index % 2 === 1 ? sanitizeUrl(piece) : maskCredentialMaterial(piece)))
        .join("");

// A whole form-encoded body (an OAuth token exchange: code, code_verifier, client_secret) is masked like a query.
const FORM_BODY = /^[\w.%+-]+=[^&\s]*(?:&[\w.%+-]+=[^&\s]*)*$/;

const HEADER_LINE = /^(\s*)([!#$%&'*+.^_`|~0-9A-Za-z-]+): (.*)$/;
const HEADER_SECTION = /^\s*(?:Request|Response) headers$/;

// The answer is markdown: `### Result` followed by either the details block (a General section, then header sections
// opened by their title and closed by a blank line) or one part on its own. Headers are told from General's `status:`
// lines by the section they sit in, not by their shape, which is the same.
const redactNetworkText = (text: string, part: NetworkCall["arguments"]["part"]): string => {
    const headersPart = part === "request-headers" || part === "response-headers";
    const bodyPart = part === "request-body" || part === "response-body";
    let inHeaders = false;
    let inResult = false;
    return text
        .split("\n")
        .map((line) => {
            if (line.startsWith("### ")) {
                inResult = line === "### Result";
                inHeaders = inResult && headersPart;
                return line;
            }
            if (HEADER_SECTION.test(line)) {
                inHeaders = true;
                return line;
            }
            if (line.trim() === "") {
                inHeaders = inResult && headersPart;
                return line;
            }
            const header = inHeaders ? HEADER_LINE.exec(line) : null;
            if (header !== null) {
                const [, indent = "", name = "", value = ""] = header;
                return SAFE_HEADERS.has(name.toLowerCase()) ? `${indent}${name}: ${sanitizeText(value)}` : `${indent}${name}: ${MASK}`;
            }
            return inResult && bodyPart && FORM_BODY.test(line) ? maskQuery(line) : sanitizeText(line);
        })
        .join("\n");
};

// `filename` makes the backend write the answer, unredacted, to its output directory and return only the path; any
// shell in the sandbox could then read what the router never saw.
export const networkCallRefusal = (call: NetworkCall): string | undefined =>
    call.arguments.filename === undefined
        ? undefined
        : `${call.name} does not take \`filename\` here: its answer is redacted on the way back, and a file would skip that. Call it again without \`filename\`.`;

export const redactNetworkAnswer = (call: NetworkCall, answer: RpcMessage): RpcMessage => {
    const parsed = AnswerSchema.safeParse(answer.result);
    if (!parsed.success) {
        return answer;
    }
    const content = parsed.data.content.map((block) => {
        const text = TextBlockSchema.safeParse(block);
        return text.success ? { ...text.data, text: redactNetworkText(text.data.text, call.arguments.part) } : block;
    });
    return { ...answer, result: { ...parsed.data, content } };
};
