# Security Policy

## Supported versions

Security fixes go into `main` and the `latest` image (`ghcr.io/maddin-jms/aisparring:latest`).
Please update to the latest version before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately via GitHub instead:
[Report a vulnerability](https://github.com/MaDDin-JMS/aisparring/security/advisories/new)
(Security tab → *Report a vulnerability*).

Helpful details:

- what an attacker can do and what is needed for it (e.g. a valid key, admin rights, network position)
- steps to reproduce, ideally against a fresh `docker compose up` installation
- the version or commit you tested

You will get a first response within a few days. Once a fix is released, the advisory is published and
reporters are credited unless they prefer otherwise.

## Scope

In scope: the server (`src/`), the web UI (`public/`), the Docker image and the install/deploy scripts.

Out of scope: problems that require an already leaked key (rotate it), denial of service through traffic
volume alone, and missing hardening of the host system around the container.
