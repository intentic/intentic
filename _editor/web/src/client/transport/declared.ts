import { useEndpoint } from "../endpoint/useEndpoint";
import { useSandbox } from "../sandbox/useSandbox";

// Whether the address the active sandbox is reached on is an edge that DECLARED WebTransport: the sandbox row says what
// its edge serves (the platform reads it off the edge's own /health), and a loopback shortcut is no edge at all, so it
// declares nothing. Terminals and the browser's media socket ask the same question; the session itself is opened in
// whichever realm holds the socket (webTransport.ts), the page's or the decode worker's.
export const webTransportDeclared = (): boolean => {
    const { usingLocal } = useEndpoint();
    const { active } = useSandbox();
    return !usingLocal.value && (active.value?.edgeTransports ?? []).includes(`webtransport`);
};
