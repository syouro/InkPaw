# Source snapshot

InkPaw 的公开仓与私有开发仓使用独立 Git 历史。本文件记录当前公开快照的来源，用于后续增量同步和审核。

## Current public snapshot

- Public project: `syouro/InkPaw`
- Public version: `0.1.0`
- Exported at: `2026-07-15` (`Asia/Beijing`)
- Private source repository: `inkstone_dev`
- Source branch: `master`
- Source commit: `f46e2ab675562a7e15a20fcaae7c43aa0aa338b9`
- Source commit time: `2026-07-15T12:17:59+08:00`
- Source commit subject: `docs: add open-source release policy`

## Snapshot boundary

The public snapshot includes the protocol-independent renderer, MCP server, service layer, validators, SQLite store, presets, generic examples, test suites, OOXML validation assets, sanitized public documentation, and a curated local Playground migrated from the private `webchat/` implementation.

It intentionally excludes:

- the private repository's Git history;
- `reference/` legacy business/report code;
- runtime `data/`, generated documents, databases, tokens and backups;
- private WebChat deployment topology and production operations material;
- private operational history and internal agent instructions;
- customer, company or personally identifying data.

## Updating from the private source

For every later sync:

1. Record the last source commit shown above and the proposed new source commit.
2. Review the private diff between those commits; do not merge the private branch into the public repository.
3. Export only the allowlisted files described in `docs/open-source-release-policy.md`.
4. Rewrite or omit deployment-specific documentation, private examples and operational history.
5. Run secret/privacy scans, `npm ci`, `npm test`, and the release-policy checklist in the public tree.
6. Update this file to the new source commit in the same public commit as the synchronized changes.
7. Keep each sync small enough to review. Prefer a curated patch over an automated full-tree copy.

If the source commit cannot be identified exactly, the public release must stop until provenance is restored.
