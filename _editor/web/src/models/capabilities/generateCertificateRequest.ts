import type { CertificateRequest, CertificateRequestInput } from "@intentic/sandbox-contract/schemas/certificate-request";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";

// Asks the sandbox for a key and a certificate request for it. The answer is the request and a token standing in for
// the key, which never leaves the sandbox. Its own module, so a test can answer it without a daemon.
export const generateCertificateRequest = (input: CertificateRequestInput): Promise<CertificateRequest> => sandboxRpc.capabilities.certificateRequest(input);
