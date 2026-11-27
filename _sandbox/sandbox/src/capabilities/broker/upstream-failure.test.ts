import { upstreamFailure } from "./upstream-failure.js";

test("a service never connected to reads as unreachable, as before", () => {
    expect(upstreamFailure("192.168.0.168", "ECONNREFUSED", true)).toBe("192.168.0.168 could not be reached through the gateway (ECONNREFUSED).");
    expect(upstreamFailure("gitlab.example.com", "UND_ERR_CONNECT_TIMEOUT", false)).toContain("could not be reached");
});

test("a request with a body dropped after connecting points at packet size, not at the service", () => {
    // The 192.168.0.168 push: the gateway connected, GitLab's nginx waited a minute for a pack that never arrived.
    const message = upstreamFailure("192.168.0.168", "UND_ERR_SOCKET", true);
    expect(message).not.toContain("could not be reached");
    expect(message).toContain("took the connection");
    expect(message).toContain("(UND_ERR_SOCKET)");
    expect(message).toContain("MTU");
});

test("a bodiless request dropped after connecting says so without blaming packet size", () => {
    const message = upstreamFailure("api.example.com", "ECONNRESET", false);
    expect(message).toBe("api.example.com took the connection through the gateway but closed it without answering (ECONNRESET).");
});
