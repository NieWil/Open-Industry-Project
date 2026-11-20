# Deploying the collab server to Azure

The collab backend (`server/index.mjs` - Hocuspocus + Yjs + SQLite) is a small
**always-on WebSocket server**. On Azure that means a **B-series VM**: it's the only
Azure compute shape that gives SQLite a real block-device disk. (Container Apps /
App Service only offer SMB-backed storage, which fights SQLite - see `docs/collab.md`.)

One VM, one instance. Do **not** run multiple replicas: the Yjs documents live in
memory per process, so multi-instance would need sticky sessions + a shared backend,
which this project's scale does not call for.

## What it runs on

| Item |
|---|
| `Standard_B1s` VM (1 vCPU, 1 GiB) |
| 30 GB Standard SSD OS disk |
| Standard public IP |

The price depends on the region and changes over time; the Azure pricing calculator has the current figure.

Egress is negligible (Yjs deltas are a few KB). `Standard_B2ats_v2` (2 vCPU burstable, AMD) is a cheap upgrade where
available - swap the `--size` below.

## Prerequisites

- `az` CLI logged in (`az login`) to the right subscription.
- A subdomain you control. We'll use `collab.openindustryproject.org` (DNS for the domain
  is on Cloudflare, and `www` is Cloudflare Pages; this is just one extra A record there).

---

## 1. Provision the VM

Run from the `server/` directory (so `--custom-data` finds `cloud-init.yaml`):

```bash
az group create -n oip-collab -l eastus

az vm create \
  -g oip-collab -n oip-collab-vm \
  --image Ubuntu2404 \
  --size Standard_B1s \
  --admin-username azureuser \
  --generate-ssh-keys \
  --custom-data cloud-init.yaml \
  --public-ip-sku Standard \
  --storage-sku StandardSSD_LRS \
  --os-disk-size-gb 30

# open HTTP (for the Let's Encrypt challenge) + HTTPS/WSS
az vm open-port -g oip-collab -n oip-collab-vm --port 80,443 --priority 1001
```

Note the `publicIpAddress` from the output.

> Before deploying code, **edit the domain** in the VM's `/etc/caddy/Caddyfile` if you
> aren't using `collab.openindustryproject.org` (cloud-init wrote the default). SSH in
> with `ssh azureuser@<publicIpAddress>`.

## 2. Point DNS at the VM

In Cloudflare DNS, add an **A record** with proxy status **DNS only** (unproxied: the
WebSocket and Caddy's TLS go straight to the VM; see
[docs/cdn-runbook.md](../docs/cdn-runbook.md)):

```
collab   A   <publicIpAddress>   (DNS only)
```

Wait for it to resolve (`nslookup collab.openindustryproject.org`) before the next step -
Caddy can't get a TLS cert until the name points here.

## 3. Deploy the app code

From your machine, in the repo root. We ship only `server/` and skip `node_modules` and
the local dev DB (the live DB lives at `/var/lib/oip-collab` on the VM):

```bash
rsync -az --delete \
  --exclude node_modules --exclude '*.sqlite' \
  server/ azureuser@<publicIpAddress>:/tmp/server/

ssh azureuser@<publicIpAddress> '
  sudo rsync -a --delete --exclude node_modules /tmp/server/ /opt/oip-web/server/ &&
  sudo chown -R oip:oip /opt/oip-web/server &&
  cd /opt/oip-web/server &&
  sudo -u oip env HOME=/opt/oip-web npm ci --omit=dev &&
  sudo systemctl enable --now oip-collab.service
'
```

## 4. Verify

```bash
# service up?
ssh azureuser@<publicIpAddress> 'systemctl status oip-collab --no-pager'

# TLS + WebSocket reachable? (101 Switching Protocols = good)
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  https://collab.openindustryproject.org/
```

Logs: `ssh azureuser@<ip> 'journalctl -u oip-collab -f'`.

## 5. Wire the frontend and go live

Nothing to do for `collab.openindustryproject.org`: `.github/workflows/deploy-pages.yml`
already builds with `VITE_COLLAB_URL=wss://collab.openindustryproject.org`, and a production
build with it unset defaults to the same URL (`PRODUCTION_COLLAB_URL` in
`src/collab/provider.ts`, which is what the desktop installers use). For a **different**
server, change both, **after** step 4 passes so the Share button never points at a dead
server, then commit and let CI redeploy. Share, Invite and **View link** are not gated behind a build flag.

---

## Operations

**Ship a new server version** - one command from the repo root:
```bash
bash server/deploy.sh        # or: HOST=azureuser@<ip> bash server/deploy.sh
```
`deploy.sh` targets the SSH host alias `oip-collab` by default, so no VM IP is baked
into the repo. Define it once in `~/.ssh/config`:
```
Host oip-collab
    HostName <publicIpAddress>
    User azureuser
```
It repackages `server/`, reinstalls prod deps, restarts the service, and checks the
`wss://` handshake. This is the deliberate manual path - we don't store a privileged VM
SSH key in GitHub Actions to automate a server that changes rarely. (Equivalent to
re-running step 3 + `systemctl restart oip-collab` by hand.)

**Part assets live beside the db.** A room keeps a part's embedded models as hashes, and their
bytes in `/var/lib/oip-collab/assets/` (one file per SHA-256; [`assets.mjs`](assets.mjs)),
served at `https://collab.openindustryproject.org/assets/<sha256>` through the same Caddy site.
Anyone can GET a hash; only a room's edit secret can PUT, capped by `MAX_ASSET_MB` (25) per file
and `MAX_ASSET_MB_PER_IP_HOUR` (200). `ASSET_DIR` moves the folder (it must stay under
`ReadWritePaths`). The daily GC deletes an asset no stored room or snapshot names once it is a day
old. Check it after a deploy with `curl -I https://collab.openindustryproject.org/assets/$(printf
'%064d' 0)`: a 404 that carries `x-oip-asset-store: 1` means the route is live (editors only write hashes once
they see it, so the web app may deploy before this server does).

**Backups are automatic.** `deploy.sh` installs `oip-collab-backup.timer` (daily 03:30
UTC), which runs [`backup.sh`](backup.sh): an online `sqlite3 .backup` of the live db,
gzipped into `/var/lib/oip-collab/backups/`, newest 14 kept, and an add-only mirror of the
part assets in `backups/assets/` (files never change, so it only ever copies what is new).
Useful commands:
```bash
ssh azureuser@<ip> 'systemctl list-timers oip-collab-backup.timer'   # next/last run
ssh azureuser@<ip> 'sudo systemctl start oip-collab-backup.service'  # back up right now
scp 'azureuser@<ip>:/var/lib/oip-collab/backups/*' ./                # pull them off-box
```
(Off-box copies are still your job - pull one periodically or add an azcopy-to-blob line
to `backup.sh` if the VM ever holds data you can't lose.)

**Before removing an entry from `RETIRED_SHAPE_KINDS`** (`src/core/parts/partUpgrade.ts`): rooms outlive
the build that wrote them, and once an entry is gone a room still holding that kind fails to load. Pull a fresh
backup and let the repo judge it (grace period read from git, every stored room AND snapshot decoded):
```bash
ssh azureuser@<ip> 'sudo systemctl start oip-collab-backup.service'
scp 'azureuser@<ip>:/var/lib/oip-collab/backups/collab-*.sqlite.gz' ./ && gunzip -f collab-*.sqlite.gz
npm run retired-kinds -- --db ./collab-<stamp>.sqlite     # delete an entry only on REMOVABLE
```

**Restore a single room** - the server snapshots every active room into the `snapshots`
table (default: every 30 min while edited, newest 24 kept per room). To roll a vandalized
or broken room back:
```bash
ssh azureuser@<ip>
sudo systemctl stop oip-collab
sudo sqlite3 /var/lib/oip-collab/collab.sqlite \
  "SELECT id, datetime(ts/1000,'unixepoch') FROM snapshots WHERE name='<doc name>' ORDER BY ts DESC;"
sudo sqlite3 /var/lib/oip-collab/collab.sqlite \
  "UPDATE documents SET data=(SELECT data FROM snapshots WHERE id=<chosen id>) WHERE name='<doc name>';"
sudo systemctl start oip-collab
```
(The doc name is `r-<hash>`, the `?room=` value of the room's **view** link. Clients rejoin and pick up the restored state; ask
collaborators to reload so stale local IndexedDB caches don't re-merge the bad edits.)

**Uptime monitoring** - the server answers `GET /healthz` through Caddy:
```bash
curl https://collab.openindustryproject.org/healthz
# {"ok":true,"uptimeSec":…,"openDocs":…}
```
Point any free uptime monitor (UptimeRobot, Azure availability test) at that URL.

**Tuning knobs** (env vars on the service, defaults in `index.mjs`): `MAX_DOC_MB` (25, also
the largest single WebSocket frame accepted), `MAX_AWARENESS_KB` (256, one presence message),
`MAX_CONNS_PER_IP` (32, an IPv6 client counts by its /64), `MAX_NEW_ROOMS_PER_IP_HOUR` (60),
`ROOM_TTL_DAYS` (90, `0` = keep rooms forever), `SNAPSHOT_MINUTES` (30, `0` = off),
`SNAPSHOT_KEEP` (24; a room whose bytes equal its newest snapshot is not copied again). Set them
with `Environment=` lines in `/etc/systemd/system/oip-collab.service`.

**The server listens on `127.0.0.1` only** (`HOST`, default `127.0.0.1`). Caddy on the same VM is
the only way in, and the per-IP limits trust `X-Forwarded-For` only from a loopback peer, so
port 1234 must never be reachable from outside. Caddy has to proxy to `127.0.0.1:1234`, not
`localhost:1234` (which may resolve to `::1` first). `deploy.sh` rewrites a Caddyfile that says
`localhost`. Set `HOST=0.0.0.0` only on a box with no proxy in front.

**Optional: dedicated data disk.** The DB on the OS disk is durable (managed disk, survives
restarts) and fine for this scale. For isolation, attach a data disk
(`az vm disk attach --new ...`), mount it at `/var/lib/oip-collab`, and `chown oip:oip` it
before starting the service.

**Patching**: `sudo apt update && sudo apt upgrade` periodically, or
enable `unattended-upgrades`.
