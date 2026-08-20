// APIs fronted by Cloudflare can answer with the edge's whole HTML error page instead of a JSON body,
// e.g. error 1033 when the host's tunnel has no connected connector. Dumping that page into an Error buries
// the actual cause, so collapse any error body to one bounded, classified line before it reaches a message.

const MAX_DETAIL = 300;

// Cloudflare edge error pages embed their numeric code in the feedback beacon ("errorCode: 1033") and carry
// a "Cloudflare" <title>; require both so an ordinary body that merely mentions a number is never misread.
const CF_PAGE = /<title>[^<]*Cloudflare[^<]*<\/title>/i;
const CF_CODE = /errorCode:\s*(\d+)/;

const CF_HINTS: Record<string, string> = {
    "1033": "the tunnel has no connected connector — cloudflared on the host is down or still re-registering",
};

export const responseDetail = async (response: Response): Promise<string> => {
    const body = await response.text();
    const code = CF_PAGE.test(body) ? CF_CODE.exec(body)?.[1] : undefined;
    if (code !== undefined) {
        const hint = CF_HINTS[code];
        return `Cloudflare edge error ${code}${hint === undefined ? "" : `: ${hint}`}`;
    }
    const text = body
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
};
