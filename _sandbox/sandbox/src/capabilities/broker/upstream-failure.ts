// What the gateway says when the service behind it never answered. Built from the host and the failure's code only
// (undici's, from the fetch error's cause): an error's own text can quote the URL, and a path-borne credential is in it.

// Failures that happen after the connection was made: the service took it, then it went away before an answer.
const AFTER_CONNECT = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_HEADERS_TIMEOUT", "ECONNRESET", "EPIPE"]);

// A request whose body was lost after connecting is what a path dropping large packets looks like: the handshake and
// a small request fit in single packets and pass, a git push's pack does not, and the service gives up waiting for it
// (a minute later, behind GitLab's nginx). Saying "could not be reached" there sent a reader after the service instead.
export const upstreamFailure = (host: string, code: string, sentBody: boolean): string => {
    if (!AFTER_CONNECT.has(code)) {
        return `${host} could not be reached through the gateway (${code}).`;
    }
    if (!sentBody) {
        return `${host} took the connection through the gateway but closed it without answering (${code}).`;
    }
    return `${host} took the connection through the gateway but closed it without answering a request that carried a body (${code}). If small requests to it work and only larger ones (a git push, an upload) end like this, packets above some size are being dropped on the way there, most often inside a VPN tunnel: set a lower MTU on that VPN's capability.`;
};
