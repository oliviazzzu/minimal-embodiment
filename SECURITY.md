# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project — for example, a way
for an unauthorized party to access a deployed bridge, drive the device, or
extract sensor data — please **do not file a public issue**.

Use **GitHub's private vulnerability reporting** instead — [open a private security advisory](https://github.com/oliviazzzu/minimal-embodiment/security/advisories/new).

I'll aim to acknowledge any report within **7 days** and let you know what
the timeline looks like for a fix. Please give me a reasonable window to
investigate and patch before any public disclosure.

## Scope

In scope:

- The Node.js bridge service (`src/http-bridge.ts`)
- The ESP32 firmware (`firmware/sensor_body/sensor_body.ino`)
- The validation/measurement scripts (`scripts/`)
- The published validation data (`data/`) — only insofar as it could leak
  unintended personal information

Out of scope (issues with these should be reported to the upstream projects):

- Vulnerabilities in third-party dependencies (`npm` packages, Arduino
  libraries) — please report those to their maintainers
- Issues with Cloudflare Tunnel, Cloudflare's edge, or your local network

## Out of Scope (Design Choices, Not Vulnerabilities)

The following are deliberate design choices documented in the paper, not
vulnerabilities — please don't file reports about them:

- **Bearer-token auth at the bridge** — the threat model assumes the token
  is a shared secret between the LLM and the device owner. See paper §5.
- **Lack of TLS termination at the bridge itself** — TLS terminates at
  Cloudflare Tunnel; the local bridge listens on plain HTTP behind the
  tunnel. This is intentional.
- **Side-channel timing on echo measurements** — the echo windows are
  short and not constant-time; they're not a security primitive.

## Supported Versions

This is a research/personal project, not a hardened product. The latest
commit on `main` is what I'll respond to security reports on. Older
commits are not maintained.

---

Thank you for helping keep the project, and the body it animates, safe.
