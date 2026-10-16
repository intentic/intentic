# privacy-detect

Finds personal data in any text on this machine, with no model and no network: the privacy shield's detectors, from PESEL and card numbers to Polish and English names.

- One synchronous pass per kind over tool output, database dumps, CSV, JSON, prose, code and mail, so the shield's
  gateway can mask a request without waiting on anything. Every value it masks is put back in the answer, so a false
  find costs the model a little understanding while a missed one leaks: the rules lean to finding, except in code,
  where identifiers must stay readable.
- Identifiers are held to their own algorithms (PESEL, NIP, Polish ID cards and passports, IBAN and NRB accounts, Luhn with an
  issuer's prefix), so a run of digits is a find only when its checksum says so.
- A name is masked only as a name: a first name with a surname that is no ordinary word, or what a title, a field for
  a part of a name or a personal mail address vouches for. The lists under `src/data/` are generated from public name
  and word corpora by the `generate*.mjs` scripts beside them, run by hand.
- The owner adjusts the lists in the privacy shield's policy: any list in `name-lists.ts` can be switched off, and
  lists of their own (first names, surnames, ordinary words, titles, never-names) are read beside the rest.
  `createLexicon` builds the lexicon for one such configuration, and `detectPersonalData` takes it as `lexicon`;
  without one, every built-in list is read.
- `standalone.ts` says which finds may be matched again on their own: the daemon's vault and its local name model hold
  their finds to it.
- Private: the daemon depends on it for the shield (`privacy/` in [`@intentic/sandbox`](../sandbox)). Subpath exports
  keep each reader to what it needs: `.` is the detector, `./standalone` and `./text` the rules the vault shares,
  `./data/*` the lists, `./name-lists` the registry of them the privacy page describes, `./lexicon` a word's reading,
  and `./testing` builds valid identifiers for the daemon's suites.

(2026-10-16: this was `src/privacy/detect/` inside the daemon until it became its own package. It imported nothing of
the daemon but one type from the contract.)

## Key files

- [src/detect.ts](src/detect.ts) — `detectPersonalData`: every detector over one text, its spans resolved.
- [src/names.ts](src/names.ts) — first name and surname, titles and name fields, in Polish and English.
- [src/checksums.ts](src/checksums.ts) — the identifiers' own validity checks.
- [src/standalone.ts](src/standalone.ts) — which finds stand alone, for the vault and the name model.
- [src/lexicon.ts](src/lexicon.ts) — what the lists say a word is: a name, an ordinary word, a title; `createLexicon` for the owner's configuration.
- [src/name-lists.ts](src/name-lists.ts) — every list the owner can switch off, its source and where its words go.
- [src/tests/ids.testing.ts](src/tests/ids.testing.ts) — valid identifiers computed from their parts, for tests.

## Commands

```sh
pnpm --filter @intentic/privacy-detect test
```
