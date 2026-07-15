# Contributing to InkPaw

Thanks for helping the little ink paw keep documents tidy.

## Before opening a pull request

1. Open an issue for large behavior or architecture changes.
2. Keep the renderer protocol-independent: `src/docxUtil.js` must not depend on MCP or SQLite.
3. Validate external document definitions and filesystem paths at boundaries.
4. Put reusable style choices in `presets/*.json`; do not hard-code customer fonts, margins or branding in source.
5. Add focused tests for validation, transforms, persistence, templates, MCP tools or rendering XML.
6. Do not include real documents, customer data, credentials, generated outputs or private deployment information.

## Development

```bash
npm install
npm test
```

For rendering changes:

```bash
npm run demo
scripts/docx2png.sh data/output/demo-report.docx
npm run validate -- data/output/demo-report.docx
```

Visual baselines depend on LibreOffice and installed fonts. Update them only after reviewing the rendered pages.

## Pull requests

- Use a focused title and explain the user-visible behavior.
- Include test evidence.
- Attach rendered page images when layout changes.
- Call out compatibility changes for Word, LibreOffice or WPS.
- Use `Signed-off-by` to certify that you have the right to submit the contribution.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
