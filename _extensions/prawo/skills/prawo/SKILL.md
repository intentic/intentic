---
name: prawo
description: Polish law from official public sources. `prawo` finds acts in the Sejm's ELI database (Dziennik Ustaw, Monitor Polski), says whether they are in force, quotes the current consolidated text with a ready citation, and searches court rulings (SAOS). Use for any Polish statute, regulation, KPA question or ruling.
---

# Polish law · Prawo polskie

`prawo` is on your PATH and needs no account. Reach for it before any web search whenever someone asks what Polish law
says: a statute (ustawa), a regulation (rozporządzenie), the KPA, a deadline, a definition, a legal basis for a
decision. Run `prawo --help` for every flag. Add `--json` for structured output.

## The three steps for any quotation

1. **Find the act.** `prawo search "<words of the title>"`. Titles inflect their subject, so search the form the
   title uses: "o dowodach osobistych", "w sprawie instrukcji kancelaryjnej", "Kodeks postępowania administracyjnego".
   If the exact words find nothing, `prawo` retries with word stems by itself. Narrow with `--type Ustawa`,
   `--year 2010`, `--in-force`. The act itself is listed before its amendments ("nowelizacja") and consolidated
   texts ("tekst jednolity"). Use its address, e.g. `DU/2010/1131`.
2. **Check its status.** `prawo show DU/2010/1131` says whether it is in force (`obowiązuje`), its newest
   consolidated text with the date its wording is current to ("stan prawny na"), and every amendment that took or will
   take effect after that date. A repealed act says which act repealed it: quote that one instead.
3. **Quote the provision.** `prawo article DU/2010/1131 31 ust. 2 pkt 3` prints the provision, its subdivisions,
   the footnotes about it ("Dodany przez…", "W brzmieniu ustalonym przez…") and the lines to cite it by.

```sh
prawo search "Kodeks postępowania administracyjnego" --type Ustawa
prawo show DU/1960/168
prawo article DU/1960/168 35 § 3        # termin załatwienia sprawy (KPA)
prawo article DU/1960/168 37            # ponaglenie na bezczynność lub przewlekłość
prawo article DU/1960/168 "39¹"         # also 39^1, 39[1]
prawo article DU/2010/1131 31 ust. 2    # formularz odbioru dowodu osobistego
prawo article DU/2011/67 zał. 1 § 5     # znak sprawy, instrukcja kancelaryjna (annex 1)
prawo text DU/1960/168 --from 35 --to 38
```

## What to put in your answer

- **Quote the wording `prawo` printed, never a paraphrase from memory.** Keep the unit label ("§ 3.", "2.", "3)").
- **Cite every quote with the `Cytat:` line**: provision, act, and the consolidated text's journal address, for
  example *art. 35 § 3 ustawy z dnia 14 czerwca 1960 r. – Kodeks postępowania administracyjnego (Dz. U. z 2025 r.
  poz. 1691)*. Also give the consolidated text's date from the `Źródło:` line ("stan prawny na 2025-11-03").
- **Say whether the act is in force**, and if `Akt:` lists amendments after the consolidated text, check whether they
  touch the provision (`prawo show` names them) before calling the wording current. A pending amendment
  ("zmiany oczekujące", "wejdzie w życie") changes the law from that date: say so.
- A provision can appear twice when a new wording takes effect later; the footnotes say which applies when.
- `--unified` reads the Chancellery's unified text ("tekst ujednolicony"): it already includes later amendments but
  has no legal force. Use it to see what changed, and cite the consolidated text and the amending act.
- `--original` is the act as first published, not the law today.

## Court rulings (orzecznictwo)

```sh
prawo rulings search "bezczynność organu" --act DU/1960/168 --limit 5
prawo rulings search --regulation "art. 35" --act DU/1960/168 --from 2024-01-01
prawo rulings show 552277
```

Rulings are **illustrative, not binding**: Polish courts do not follow precedent, so present a ruling as an example of
how a court read a provision, with its citation (court, form, date, case number). Check that the provision it applied
has not changed since. SAOS is current for the common courts, stops in 2016 for the Supreme Court, 2015 for the
Constitutional Tribunal and 2018 for KIO, and holds **no administrative court rulings** (WSA, NSA): for those, point
to the NSA's own database, orzeczenia.nsa.gov.pl, and say that `prawo` cannot search it.

## When `prawo` cannot answer

- A PDF-only text from before 2012 can mix the masthead into the first page's articles; compare with the `plik:` link
  in the `Źródło:` line when a quote looks odd.
- No articles in a text (a table, a form, a scanned act): open the PDF with `fileq read <file>` and quote by hand.
- Texts read once are cached in the workspace and work offline; `--refresh` asks the sources again.
