English · [中文](SECURITY.zh.md)

# Security Policy

## Reporting vulnerabilities

**Do not** report security problems through a public issue. Use any one of these private channels:

- The private vulnerability report on the repository's **Security** tab (`Report a vulnerability`, if it is enabled for that repository)
- Email: **github@arjenzhou.com**

Please include in your report: the affected component (CLI / interactive terminal / native Mac app / phone PWA / Relay / tunnel provider / deployer), reproduction steps, the impact you actually observed (not just a theoretical possibility), and whether other people's data is involved.

## How we handle it

This is a personally maintained project with **no SLA**. But we will do this: acknowledge receipt → assess the scope and severity → fix → credit you in the fix notes (unless you ask to stay anonymous). Details stay private until a fix is available.

## Supported scope

There is currently **no released version**, so the latest commit on main is the reference; older commits do not get separate patches. The native client evolves together with the main repository, so for a security problem, please say which commit of which repository you tested.

## Design boundaries (these are not vulnerabilities)

- **Paired devices cannot do host administration**: administration requests are accepted only locally. This is a deliberate permission boundary, not a missing feature; if you can make a remote device change host settings, that is a vulnerability.
- **Model credentials are not in the clients**: `TURNWIRE_HARNESS_DEEPSEEK_API_KEY` is read only by DSH on the host, and clients, the Relay, and tunnel processes cannot obtain it. If you see the key in any of those places, that is a vulnerability.
- **The Relay forwards ciphertext only**: per-connection ECDH session encryption; the Relay's connection routing is in memory, while push keys and the delivery queue are persisted. The Relay cannot see session contents.
- **Temporary tunnels are third-party services**: localhost.run, cpolar, and Cloudflare are outside this project's control. `127.0.0.1` refers only to the current device, not to "this Mac".
- **Networks in mainland China cannot reach Cloudflare, and phone push is unavailable behind a temporary address**: availability limitations, not security vulnerabilities (push requires a self-hosted Relay).

## Testing discipline

- Test only **your own** host, accounts, and devices; do not scan or probe other people's instances.
- Do not read, export, or retain other people's session data in order to prove a vulnerability; the minimum evidence that demonstrates the impact is enough.
- If you suspect a credential has leaked, report it immediately and rotate it at the same time (`TURNWIRE_HARNESS_DEEPSEEK_API_KEY`, Relay token, pairing credentials).
