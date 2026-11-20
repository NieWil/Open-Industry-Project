# Security Policy

## Reporting a Vulnerability

Please don't open a public issue for a security problem.

Report it privately through GitHub instead: go to the repository's **Security** tab and
choose **Report a vulnerability**. This opens a private advisory that only you and the
maintainers can see.

It helps to include what an attacker could gain, the steps to reproduce it, your browser
and GPU backend if it's related to rendering or the simulation worker, and whether you found
it on the live site, the desktop app or a local build.

We'll try to respond within about a week. This is a small project, so if a fix takes
longer we'll keep you updated in the advisory. Please give us a chance to release a fix
before disclosing it publicly.

## Supported Versions

Only the live site at `www.openindustryproject.org` and the latest desktop app release are
supported. The desktop app updates itself, so fixes ship as a new version. If you're on an
older release, update before reporting.

## In Scope

- The website and editor (`/`, `/app/`, `/plc/`)
- The desktop app, including its local servers, its PLC connections and the links that
  open it from a browser
- The collaboration server and the room access model
- The custom part sandbox
- The PLC engine and its program importers (PLCopen XML)
- The cross-origin isolation headers in `public/_headers`

## Known Limits

These are deliberate design decisions, not vulnerabilities, so you don't need to report
them.

### Custom parts run untrusted code in a sandbox

Custom parts contain JavaScript, which runs in an
[SES](https://github.com/endojs/endo/tree/master/packages/ses) sandbox with no access to the
page, storage or the network. A part can still use up memory until the tab crashes, and
the sandbox can't protect against bugs in SES itself. If SES can't run, part code from
collaboration rooms is held back until you allow it. See
[docs/part-sandbox.md](docs/part-sandbox.md).

### Collaboration rooms share part code

Everyone in a room gets every participant's part code. In a browser it runs sandboxed, and
you can **Block** the room. In the desktop app, code from a room doesn't run until you
allow the room.

### Collaboration uses links instead of accounts

There are no accounts. Anyone with a room's edit link can edit it, so treat the link as a
password. View-only links are enforced by the server. See [docs/collab.md](docs/collab.md).

### The desktop app's local servers have no passwords

- The **AI agent connection**, which lets an AI agent control the editor, is off until you turn it on
  under **Settings > Agent connections** (**Help > Agent Connections…** opens it). While it's on, any program on your computer can edit
  the open project.
- The built-in **OPC UA server** and **Modbus TCP server** have no login. They only accept
  connections from your own computer unless you set them to listen on the network.

The desktop app asks before it first connects to, or listens on, any address outside your
computer, and it only touches files in folders you've opened or created in it.

### Your projects are stored on your device

There's no server-side copy of a project you edit alone. It's kept in your browser's
storage, or in a folder on disk in the desktop app, so anyone with access to your browser
profile or that folder can read it.

### Self-hosted servers are your responsibility

[server/DEPLOY.md](server/DEPLOY.md) describes the reference setup. If you host your own
instance, securing it is up to you.

## Out of Scope

- Denial of service or load testing against the live site or the collaboration server
- Misconfiguration of a self-hosted instance that the reference setup doesn't have
- Automated scanner results without a demonstrated impact, and missing hardening headers on
  pages that aren't meant to be cross-origin isolated
- Social engineering, or physical access to someone's computer or browser profile
