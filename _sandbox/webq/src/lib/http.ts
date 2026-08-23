/* The static fetch path — where every page starts, and where most docs pages end. Node's own fetch
 * (undici) with the three guards a crawler cannot skip: a deadline, a byte cap enforced WHILE streaming
 * (a Content-Length header is a claim, not a promise), and charset decoding from the header with a
 * meta-tag fallback, because a mislabeled legacy page decoded as UTF-8 turns into mojibake markdown. */

export interface HttpFetchOptions {
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly userAgent?: string;
}

export interface HttpPage {
    readonly url: string;
    /** Where redirects landed — the base every relative link resolves against. */
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
    /** True when the byte cap cut the body short — the capsule must say so. */
    readonly truncated: boolean;
}

// A current-Chrome UA with webq named at the end: enough for the CDNs that 403 anything without a browser
// token, honest to anyone who reads their logs. The browser fallback presents real Chromium anyway.
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 webq";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const httpFetch = async (url: string, options: HttpFetchOptions = {}): Promise<HttpPage> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            "user-agent": options.userAgent ?? USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            "accept-language": "en-US,en;q=0.9",
        },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const { bytes, truncated } = await readCapped(response, maxBytes, timeoutMs);
    return {
        url,
        finalUrl: response.url === "" ? url : response.url,
        status: response.status,
        contentType,
        body: decode(bytes, contentType),
        truncated,
    };
};

const readCapped = async (response: Response, maxBytes: number, timeoutMs: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
    if (response.body === null) {
        return { bytes: new Uint8Array(0), truncated: false };
    }
    const deadline = Date.now() + timeoutMs;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
        if (Date.now() > deadline) {
            await reader.cancel();
            return { bytes: concat(chunks, total), truncated: true };
        }
        const { done, value } = await reader.read();
        if (done) {
            return { bytes: concat(chunks, total), truncated: false };
        }
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
            await reader.cancel();
            return { bytes: concat(chunks, total).slice(0, maxBytes), truncated: true };
        }
    }
};

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
};

const decode = (bytes: Uint8Array, contentType: string): string => {
    const headerCharset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
    const sniffed = headerCharset ?? sniffMetaCharset(bytes);
    try {
        return new TextDecoder(sniffed ?? "utf-8", { fatal: false }).decode(bytes);
    } catch {
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
};

// The <meta charset> lives in the first kilobytes by spec; sniff it from an ASCII-safe decode of the head.
const sniffMetaCharset = (bytes: Uint8Array): string | undefined => {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
    return (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head))?.[1];
};
