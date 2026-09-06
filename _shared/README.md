# Shared

The contracts and SDKs more than one part is written against — the wire the editor and the daemon both speak,
the SDK an extension author is allowed to depend on, and the file formats that cross a boundary.

Every one of these was reachable before only by naming somebody else's part — the wire contract sat under the
sandbox and was imported from nine parts; the capability catalog sat under the platform and was used by both
hubs and never by the platform itself — which read as a dependency on THAT part rather than on a shared
contract. A package sitting here says what it is: the thing in the middle, owned by nobody, changed with care.

## What may live here

A package belongs in `_shared/` when one of these is true:

- packages in **three or more parts** import it;
- **both hubs** — `_editor` and `_sandbox` — import it;
- it is part of the **SDK an extension author may depend on** (`_extensions/README.md` lists that set, and
  `.oxlintrc.json` enforces it).

And one rule holds without exception: **nothing in `_shared/` may import from any other part.** A shared
package that reached back into the daemon or the web app would make the middle a cycle, and every consumer
would inherit the part it was supposed to be free of.

`_deploy/graph` and `_deploy/resources` are the near misses, and they stay where they are: seven of ten and
three of four of their dependents are deploy-internal, so moving them would only widen the middle.

## What is here

| package                                          | what it is                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| [sandbox-contract](sandbox-contract)             | the wire: every route, schema and event the editor and the daemon agree on     |
| [sandbox-openapi](sandbox-openapi)               | the OpenAPI document generated from that contract                              |
| [sandbox-run](sandbox-run)                       | the `docker run` contract — how a sandbox container is spelled                 |
| [extension-api](extension-api)                   | the SDK an extension's backend is written against                              |
| [extension-manifest](extension-manifest)         | what an extension declares, and the identity derived from it                   |
| [extension-ui](extension-ui)                     | the SDK half an extension's screens are written against                        |
| [connector-runtime](connector-runtime)           | the SDK half a gateway extension is written against                            |
| [registry](registry)                             | the extension-registry file format                                             |
| [workspace-ignore](workspace-ignore)             | which paths are never read: the secrets floor, shared by editor, daemon and iq |
| [api-contract](api-contract)                     | the wire between the web app and the platform API                              |
| [capability-catalog](capability-catalog)         | what a capability is, and every kind there is                                  |
