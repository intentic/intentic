import { type Flags, type Parsed, parseFlags, valuesOf } from "./secret-command-flags.js";
import { hostsOf, WEB_SCHEMES } from "./secret-command-hosts.js";
import { type ProgramReader, STAND_IN, type Unreadable } from "./secret-command-words.js";

// A fetcher's option table: besides the grammar, the options whose value is a URL it fetches (its positionals are URLs
// too), and what its options do together that no single one of them says.
interface FetcherTable extends Flags {
    readonly destinations: ReadonlySet<string>;
    readonly check: (parsed: Parsed) => Unreadable | undefined;
}

const STEERS_PROXY = "it sends through a proxy or a changed address";
const STEERS_CONFIG = "it reads more options from a file";
const STEERS_REDIRECT = "it follows redirects, which can lead to any host";
const STEERS_TRUST = "it skips checking the server's certificate, so the host it names may not be the one that answers";
const STEERS_KEEPS = "it writes the request, secret included, somewhere a later command can read it";
const STEERS_VARIABLES = "it fills in parts of the command from variables when it runs";

// curl's write-out is a small language, not just text to print. A template from a file or a run-time value is unread,
// and %output{...} opens a file; %% escapes a literal percent and cannot introduce that directive.
const curlWriteOut = (parsed: Parsed): Unreadable | undefined => {
    for (const word of valuesOf(parsed, "w", "write-out")) {
        const writes = [...word.text.matchAll(/%%|%output\{/g)].some((match) => match[0] !== "%%");
        if (word.dynamic || word.text.includes(STAND_IN) || word.text.startsWith("@") || writes) {
            return { why: STEERS_KEEPS };
        }
    }
    return undefined;
};

// wget follows redirects unless told not to, resending the headers it was given wherever they lead. The last
// --max-redirect given is the one in force.
const wgetRedirects = (parsed: Parsed): Unreadable | undefined =>
    valuesOf(parsed, "max-redirect").at(-1)?.text === "0" ? undefined : { why: STEERS_REDIRECT };

const CURL: FetcherTable = {
    values: new Set([
        ..."AbcCdDeEFHmoPQrtTuUwXyYz",
        "header",
        "data",
        "data-raw",
        "data-binary",
        "data-urlencode",
        "data-ascii",
        "json",
        "form",
        "form-string",
        "output",
        "output-dir",
        "user",
        "user-agent",
        "request",
        "cookie",
        "cookie-jar",
        "dump-header",
        "write-out",
        "max-time",
        "connect-timeout",
        "retry",
        "retry-delay",
        "retry-max-time",
        "range",
        "upload-file",
        "cacert",
        "capath",
        "cert",
        "key",
        "cert-type",
        "key-type",
        "pass",
        "oauth2-bearer",
        "referer",
        "limit-rate",
        "max-filesize",
        "url-query",
        "aws-sigv4",
        "time-cond",
        "speed-limit",
        "speed-time",
        "continue-at",
        "max-redirs",
        "local-port",
        "keepalive-time",
        "expect100-timeout",
        "tls-max",
        "ciphers",
        "proto",
        "proto-default",
        "proto-redir",
        "quote",
        "etag-save",
        "etag-compare",
        "hsts",
        "create-file-mode",
        "service-name",
        "netrc-file",
        "url",
    ]),
    destinations: new Set(["url"]),
    refuses: new Map([
        ...["x", "proxy", "preproxy", "proxy1.0", "socks4", "socks4a", "socks5", "socks5-hostname"].map((flag) => [flag, STEERS_PROXY] as const),
        ...["resolve", "connect-to", "doh-url", "dns-servers", "unix-socket", "abstract-unix-socket", "alt-svc"].map(
            (flag) => [flag, STEERS_PROXY] as const,
        ),
        ...["K", "config"].map((flag) => [flag, STEERS_CONFIG] as const),
        ...["L", "location", "location-trusted"].map((flag) => [flag, STEERS_REDIRECT] as const),
        ...["k", "insecure", "proxy-insecure", "doh-insecure"].map((flag) => [flag, STEERS_TRUST] as const),
        ...["trace", "trace-ascii", "libcurl", "stderr"].map((flag) => [flag, STEERS_KEEPS] as const),
        ["variable", STEERS_VARIABLES],
    ]),
    plain: new Set([
        ..."sSfiIvOJgGjlnNRZ012346aBMpq#:",
        "silent",
        "show-error",
        "fail",
        "fail-with-body",
        "fail-early",
        "compressed",
        "include",
        "show-headers",
        "verbose",
        "head",
        "get",
        "globoff",
        "http1.0",
        "http1.1",
        "http2",
        "http2-prior-knowledge",
        "http3",
        "no-progress-meter",
        "progress-bar",
        "remote-name",
        "remote-name-all",
        "remote-header-name",
        "no-buffer",
        "no-keepalive",
        "ipv4",
        "ipv6",
        "tcp-nodelay",
        "tr-encoding",
        "ssl-reqd",
        "tlsv1.2",
        "tlsv1.3",
        "create-dirs",
        "retry-all-errors",
        "retry-connrefused",
        "raw",
        "digest",
        "basic",
        "anyauth",
        "path-as-is",
        "parallel",
        "parallel-immediate",
        "next",
        "no-clobber",
        "remove-on-error",
        "disable",
        "styled-output",
        "no-styled-output",
        "list-only",
        "append",
    ]),
    check: curlWriteOut,
};

const WGET: FetcherTable = {
    values: new Set([
        ..."OoaUPtTwQ",
        "output-document",
        "output-file",
        "append-output",
        "header",
        "post-data",
        "post-file",
        "body-data",
        "body-file",
        "method",
        "user",
        "password",
        "http-user",
        "http-password",
        "user-agent",
        "directory-prefix",
        "tries",
        "timeout",
        "wait",
        "referer",
        "load-cookies",
        "save-cookies",
        "quota",
        "limit-rate",
        "ca-certificate",
        "certificate",
        "private-key",
        "progress",
        "max-redirect",
    ]),
    destinations: new Set(),
    refuses: new Map([
        ...["e", "execute", "config", "i", "input-file", "B", "base"].map((flag) => [flag, STEERS_CONFIG] as const),
        ["no-check-certificate", STEERS_TRUST],
        ...["r", "recursive", "m", "mirror", "p", "page-requisites", "H", "span-hosts"].map((flag) => [flag, STEERS_REDIRECT] as const),
    ]),
    plain: new Set([
        ..."qvSNc46",
        "quiet",
        "verbose",
        "nv",
        "no-verbose",
        "server-response",
        "continue",
        "timestamping",
        "content-disposition",
        "no-cache",
        "show-progress",
        "nc",
        "no-clobber",
        "spider",
        "inet4-only",
        "inet6-only",
    ]),
    check: wgetRedirects,
};

// curl and wget take every positional as a URL, one without a scheme as http.
const fetcherReach =
    (table: FetcherTable): ProgramReader =>
    (args) => {
        const parsed = parseFlags(args, table);
        if ("why" in parsed) {
            return parsed;
        }
        return table.check(parsed) ?? hostsOf([...parsed.positionals, ...valuesOf(parsed, ...table.destinations)], WEB_SCHEMES);
    };

export const FETCHER_READERS: ReadonlyMap<string, ProgramReader> = new Map([
    ["curl", fetcherReach(CURL)],
    ["wget", fetcherReach(WGET)],
]);
