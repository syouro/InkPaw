# Third-party notices

InkPaw is licensed under the MIT License. The project depends on and redistributes metadata or schema material from third-party projects and standards.

## Runtime dependencies

The source distribution references these direct npm dependencies; their complete dependency graphs and exact resolved versions are recorded in `package-lock.json`.

| Component | Version in source snapshot | License |
|---|---:|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT |
| `better-sqlite3` | 11.10.0 | MIT |
| `dayjs` | 1.11.21 | MIT |
| `docx` | 8.5.0 | MIT |
| `express` | 5.2.1 | MIT |
| `image-size` | 2.0.2 | MIT |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later (used under MIT) |
| `markdown-it` | 14.3.0 | MIT |
| `markdown-it-footnote` | 4.0.0 | MIT |
| `openai` | 6.47.0 | Apache-2.0 |

Dependency copyright and license texts are distributed by their respective packages. InkPaw does not copy dependency source into this repository.

## OOXML schemas

`schemas/ooxml/` contains ECMA-376 Transitional schema files obtained through the `python-openxml/python-docx` repository's `ref/xsd/` mirror on 2026-07-07. That repository is distributed under the MIT License. `xml.xsd` originates from W3C.

Local changes are limited to adding `schemaLocation="xml.xsd"` to two imports so that `xmllint` can compile the schema set, plus the separately authored `strip-mce.xslt` preprocessing transform. See `schemas/ooxml/README.md`.

ECMA-376 is published by Ecma International. Inclusion of schema files does not imply endorsement by Ecma International, W3C, Microsoft, `python-docx`, or any npm dependency maintainer.
