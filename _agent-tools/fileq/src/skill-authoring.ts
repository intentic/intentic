// Authoring rules for the documents an agent hands to a person, part of fileq's skill (skill.ts).
//
// Adapted from SurfSense's pptx, docx, xlsx and pdf skills (docker/sandbox/skills/*/SKILL.md, Copyright (c) SurfSense,
// licensed under the Apache License, Version 2.0, https://github.com/MODSetter/SurfSense; see this package's NOTICE).
// Changed: cut to the rules that decide whether a file looks right when opened (their tool calls, revision flow and
// save step are SurfSense's own product and are left out), reworded, and pointed at `fileq check` and `fileq render`
// as the verification step.

export const AUTHORING_RULES = `## Making a document someone will open
Rules that decide whether a generated file looks right (adapted from SurfSense's document skills, Apache-2.0):
- **Decks**: one purpose per slide, at most about six short bullets; titles 32–40 pt, body at least 18 pt;
  0.5 in outer margins, and every shape on the slide (no parking shapes off-canvas, no hidden spare slides).
  Fill every placeholder you keep or delete it; no prompt text, TODOs or design notes on a slide. Size each
  box to its text instead of relying on autofit, which PowerPoint and LibreOffice resolve differently: shorten
  or split the slide. Keep an image's proportions: set one side and derive the other, crop rather than stretch.
- **Word documents**: built-in heading styles, real list numbering (never a typed "•"), a page break as its
  own paragraph, margins of at least 18 mm, one page size and orientation. A table of contents only when asked,
  and say its page numbers fill in when Word updates fields. No image wider than the text column.
- **Spreadsheets**: save every formula with its computed value (XlsxWriter's \`write_formula(cell, formula,
  format, value)\`; openpyxl saves none, so recalculate its output with LibreOffice). Leave no error value
  (#REF!, #DIV/0!, #N/A) in a cell. Name sheets for the reader, set column widths, freeze header rows.
- **PDFs**: embed the fonts (register a TTF in ReportLab; WeasyPrint embeds on its own); A4 or US Letter by
  locale, margins of at least 18 mm. To turn an office file into a PDF:
  \`soffice --headless -env:UserInstallation=file:///tmp/lo-$$ --convert-to pdf --outdir <dir> <file>\`
  (its own profile per run; the output is named after the source).
- Fonts: prefer Arial, Times New Roman or Courier New where the layout is tight: LibreOffice substitutes their
  metric-compatible Liberation fonts, so lines break the same. Any other font gets about 10% spare room.`;
