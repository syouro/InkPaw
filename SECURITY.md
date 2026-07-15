# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing an unpatched exploit, credential, private document or production configuration.

If private reporting is unavailable, contact the maintainer through the GitHub profile without posting exploit details publicly. A public advisory can be prepared after a fix is available.

## Sensitive data

InkPaw processes documents and may write SQLite databases, templates, tokens and rendered outputs under `data/`. This directory is ignored by Git and must not be committed.

HTTP mode requires Bearer authentication. Keep the generated `data/mcp-token` private, bind to loopback unless remote access is intentionally configured, and terminate public traffic at a trusted authenticated gateway.

`X-Docx-Scope-User` is a trusted-gateway header, not an end-user identity assertion. Never forward an arbitrary client-provided value without authenticating and replacing it at the gateway.

The experimental Playground is a local evaluation interface. It stores BYOK model settings in browser `localStorage` and forwards them through the local server without writing the API key to the database or logs. Because users may configure an arbitrary model base URL and the identity creation endpoint has no built-in public rate limit, do not expose the Playground directly to the internet. See `docs/playground.md` for the required public-deployment controls.

## Supported versions

Security fixes are applied to the latest release on the `main` branch. Older snapshots may not receive backports.
