# e-urzad

EZD RP (the government's document management system) and e-Doręczenia (registered electronic delivery) for a Polish public office, plus electronic-signature checks, as an agent CLI, per-card MCP tools and a rail view.

Nothing happens until an office connects one of its two cards. `e-urzad verify` needs no card at all.

## What an office administrator has to obtain

**EZD RP** (one card per EZD instance):

- An API key for a technical user. Someone with the `Administracja.KluczeApi` permission at institution level creates it in EZD RP under Administracja → Klucze API → Dodaj klucz. The key's data gives the key ID (`aki`), the business owner's entity ID (`pid`) and the key value. EZD shows the value once.
- The instance's three addresses: integrator API, SSO and the web host. For NASK's sandbox these are `integrator-api.int2.ezdrp.gov.pl`, `sso-idp.int2.ezdrp.gov.pl` and `ezdrp-web.int2.ezdrp.gov.pl`. The sandbox is network-gated: NASK allow-lists your IP or sets up IPsec after you apply on gov.pl.
- The position (stanowisko, the `Sid`) the key acts in, if the user holds more than one. EZD checks every call's permissions against that position.

**e-Doręczenia** (one card per registered system):

- A system registered for the office's mailbox: Moduł uprawnień → Systemy → Dodaj system. The name given there is the card's system name.
- That system's X.509 certificate and private key, pasted as PEM. Registration either issues a certificate from a CSR, or takes the office's own qualified certificate or e-seal. On PROD, a public entity gets one free and anyone else needs a qualified one.
- The mailbox's delivery address (ADE). The choice of INT or PROD. INT admits only the public IP addresses registered with it.

Both cards keep their credentials as Intentic secrets (`secret` fields) and name the hosts those credentials are meant for.

## How it works

- **Cards and test.** The cards' own Test only checks that the SSO (EZD) or the environment's sign-in realm (e-Doręczenia) answers. Neither sign-in can be expressed as one templated request. The real connection test exchanges the key or signs the assertion and reads once. It is `e-urzad ezd test` / `e-urzad ed test`, the view's Test button, or the `ezd_test` tool.
- **Reads** go straight to the office: cases, documents, metadata, tasks; the inbox as metadata; evidences; the BAE address register.
- **Office acts are held.** Five things go through action-rule keys, all listed in the public-office preset: registering incoming mail, paper outgoing mail, adding files to a case, sending a delivery, and opening a delivery. Unset, a key holds: the exact operation and copies of its files go to the approvals queue, and nothing reaches the office. The approved turn runs `e-urzad approved <id>`. It re-checks that the item is running, that the bytes match the digest in its instructions, and that the card still points at the same office, environment and mailbox. This is the IMAP sender's pattern (`_extensions/imap`), with the same limit: the command can only read the workspace's approval file.
- **Opening a delivery is held too.** Fetching a message in full marks it opened, and for a notice it makes the delivery received (E.1), which can start the office's deadlines. Listing never opens anything.
- **Records.** Everything saved lands under `.intentic/records/e-urzad/<card>/`: the rail view's snapshot, opened deliveries with their attachments, downloaded documents, proofs, and the office acts carried out.
- **Tools.** MCP tools exist for EZD RP cards only, and are reads plus `verify_signature`. The manifest serves tools for one card kind per extension, so e-Doręczenia is CLI-only.
- **Bundles.** The CLI and the backend are self-contained vite bundles; the view is compiled into the web app.

## Signatures

`e-urzad verify` handles XAdES (enveloped, enveloping, detached with `--content`), PAdES (every `/ByteRange` signature, document time-stamps, later incremental updates reported) and CAdES/CMS (`.p7s`/`.sig` detached, `.p7m` enveloping, DER, PEM or Base64). It uses PKI.js, xadesjs/xmldsigjs and Node's WebCrypto; nothing is hand-rolled. It reports three things separately for each signature:

1. **Integrity**: digests and signature value, plus what they cover. Also the ESS / XAdES SigningCertificate binding, and signature time-stamps with their imprints (XAdES time-stamps over the canonicalised SignatureValue).
2. **Trust**: a certificate path to a service on the EU trusted list, checked at the time-stamp's time (else the claimed signing time), with the service's status at that moment. `e-urzad trust refresh` fetches the list of lists over HTTPS from ec.europa.eu. It checks the list's XML signature against the certificates the list names for itself, then fetches Poland's list (NCCert; `--territory` adds others) and checks its signature against the certificates the list of lists names for it. Without a cached list, every report says "trust chain not checked".
3. **Qualification**: QcCompliance, QSCD and QcType are reported as the certificate's claims. At best the verdict is "indicated, not confirmed".

**Not checked:**

- Revocation (no OCSP or CRL).
- The Official Journal pinning of the list of lists' signing certificates.
- PDF permissions (DocMDP) and what later revisions changed.
- The XML transforms xmldsigjs lacks (XPath Filter 2.0, C14N 1.1). These are reported as "not-checked".

Interoperability was checked by hand against the EU DSS project's test files. PAdES and CAdES results matched DSS's expectations; XAdES matched once the two unsupported transforms above are set aside. A live refresh verified the real list of lists and twelve member-state lists.

## What is verified about the office APIs, and what is assumed

Verified against public documents:

- EZD RP: the v2 OpenAPI at integrator-api.demo.ezdrp.gov.pl/swagger/v2/swagger.json, NASK's manual (podrecznik.ezdrp.gov.pl) and the SSO's discovery document.
- e-Doręczenia: the UA API 3.0.8 OpenAPI from Poczta Polska, the SE API 4.0.5 OpenAPI inside COI's design document, the INT and PROD integration instructions on gov.pl, and the PROD realm's discovery document.

No call was made with real credentials; all client tests mock HTTP.

| Part | Status |
| --- | --- |
| EZD token: `api_credentials` grant, `client_id = api_ + Base64(SHA-256(web host))`, `akh = Base64(SHA-256(rt + key))`, 3600 s | Verified (manual, NASK forum code, discovery document) |
| EZD `rt` without fractional seconds | Reported by users on NASK's forum; the manual's own example has a fraction |
| EZD `Sid` header on every call | Verified (manual and spec). That `/struktura/uzytkownik` answers without one, used when the card leaves Sid empty, is assumed |
| EZD paths, bodies and paging (`sprawy/_search`, `obiegi`, `dokumenty/{id}`, `…/metadane`, `…/link`, `POST /sprawy/{id}/dokumenty`, `POST /obiegi`, `POST /dokumenty/{id}/rpw`, `PUT /rpw/{n}/{y}/metadane`, `POST /kw/wyslanie`) | Verified (v2 spec); pageSize ≤ 25 |
| EZD JRWA symbol read off the case sign (`unit.JRWA.number.year`) | Assumed from the manual's examples; the list answer has no JRWA field |
| EZD download link: its host, whether it needs credentials | Assumed. It is fetched only on the instance's own hosts (API, web, `filerepo-api.<domain>`), first without credentials |
| e-Doręczenia login: RFC 7523 assertion, `iss = sub = <ADE>.SYSTEM.<name>`, `aud` = realm URL, `login_hint=ADE.<ADE>`, RS256 | Verified (instructions, a decoded sample token, realm discovery). ES256/384/512 for EC keys is assumed from the realm's advertised algorithms |
| UA inbox, message formats, attachments, evidences, send, task status | Verified (UA 3.0.8 spec, COI design 5.27) |
| UA attachment `file` being Base64, `fileId` chosen by the sender | Assumed (the design states Base64 for uploads; the spec gives `fileId` no rule) |
| SE `bae_search` body and `senderEda` = the mailbox | Verified (SE 4.0.5 spec) |
| UPD/UPN | Not e-Doręczenia terms. The evidences are typed A.1, E.1, BP.WX/BP.WP (proof of sending), BP.OX/BP.OP (proof of receipt); `proofs` saves them under those types |

## Key files

- [intentic-extension.json](intentic-extension.json): the two cards, the view, the bin, the per-card tools.
- [src/core/guard.ts](src/core/guard.ts): action-rule keys, holding, and the approved run's checks.
- [src/actions.ts](src/actions.ts): each office act as a proposal, and the one function that performs it.
- [src/ezd/integrator.ts](src/ezd/integrator.ts) and [src/ed/mailbox.ts](src/ed/mailbox.ts): the two API clients, with the documents they follow.
- [src/signatures/verify.ts](src/signatures/verify.ts): the verifier's entry; [src/signatures/report.ts](src/signatures/report.ts) says why integrity, trust and qualification are kept apart.
- [skills/e-urzad/SKILL.md](skills/e-urzad/SKILL.md): what the agent reads once a card is connected.
