# Deploying Baton to AWS Lightsail

One small always-on Linux server on Lightsail's 1 GB plan, a flat monthly price (`launch.sh` prints the current
price for your region before it creates anything).
Caddy terminates HTTPS with a free certificate on a `<ip>.sslip.io` hostname, so you need no domain and no
DNS setup. Baton listens only on localhost behind it, and the API sits behind a shared **access code**,
because whoever drives a session can run commands on the server.

```
phone / laptop ──HTTPS──▶ Caddy :443 ──▶ Baton 127.0.0.1:8000 (systemd, user "baton")
                                          └── /opt/baton/data: session log (SQLite) + workspaces
```

## What you need

- The AWS CLI v2, signed in: `aws login` (or `aws configure` with an access key).
  The account needs Lightsail permissions.
- `bash`, `ssh`, `ssh-keygen`, `tar` and `curl`. On Windows, Git Bash has all of them; run the scripts from
  Git Bash, not PowerShell.
- This repo checked out. **The deploy ships your working copy, uncommitted changes included**, so what
  runs on the server is what you have locally (including the built `web/dist`).

## First launch

```bash
./deploy/lightsail/launch.sh
```

It's safe to rerun: existing resources are reused. In order, it:

1. creates an SSH key in `deploy/lightsail/.ssh/` (gitignored) and imports it as a Lightsail key pair;
2. creates an Ubuntu 24.04 instance on the cheapest plan with `BATON_RAM_GB` of memory (default 1), whose
   first boot (`setup-server.sh`) installs Python, Caddy, a swap file and the `baton` systemd service;
3. allocates and attaches a static IP, and opens ports 22, 80 and 443 (never 8000);
4. waits for first boot to finish (a few minutes), then runs `deploy.sh`.

On the first deploy, `deploy.sh` creates `deploy/lightsail/server.env` (gitignored) with a random access
code, and prints:

```
  Baton is live at   https://3-91-20-7.sslip.io
  Access code        baton-k3x9q2ma
  One-tap join link  https://3-91-20-7.sslip.io/?code=baton-k3x9q2ma
```

Preview what launch would create without changing anything: `DRY_RUN=1 ./deploy/lightsail/launch.sh`.

## API keys and settings

Edit `deploy/lightsail/server.env`, then run `./deploy/lightsail/deploy.sh` again:

```bash
BATON_ACCESS_CODE=baton-k3x9q2ma
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
OPENAI_API_KEY=
```

On the server it becomes `/opt/baton/baton.env`, readable by root only. systemd reads it before starting
Baton as the unprivileged `baton` user.

## Day to day

| Command | What it does |
|---|---|
| `./deploy/lightsail/deploy.sh` | Ship your current working copy and restart (about 20 s). Sessions survive |
| `./deploy/lightsail/ctl.sh url` | Print the join link with the access code |
| `./deploy/lightsail/ctl.sh logs` | Follow Baton and Caddy logs |
| `./deploy/lightsail/ctl.sh status` | Service status, disk and memory |
| `./deploy/lightsail/ctl.sh restart` | Restart Baton (running sessions resume from the log) |
| `./deploy/lightsail/ctl.sh ssh` | Shell on the server (`ubuntu` user, sudo works) |
| `./deploy/lightsail/ctl.sh backup` | Download `/opt/baton/data` (every session and workspace) as a tarball |
| `./deploy/lightsail/teardown.sh` | Delete the instance, static IP and key pair so nothing keeps billing |

Settings you can override in the environment for any script: `AWS_REGION` (default `us-east-1`),
`AWS_PROFILE`, `BATON_INSTANCE` (default `baton`), `BATON_RAM_GB`, `BATON_BUNDLE`, and `BATON_DOMAIN`, if
you point your own domain's A record at the static IP.

## Judges on their phones

1. In your session, click **Share**. The link and QR code include the access code, so a judge scans,
   types a name, and is in.
2. They can **request** changes right away; you send each one to the agent with one tap.
3. To let them steer the agent directly, turn on **Open the floor** in the same Share menu. You keep
   decisions, interrupts and the baton.

The last slide of the in-app deck (`/pitch`) shows a QR code for the live session, with the code included.

## Security notes

- The access code is the only lock. Anyone with it can join any session, and as a driver run shell
  commands on the server as the `baton` user. Share links only with people you'd let in, rotate the code
  in `server.env` (then redeploy) after the event, and run `teardown.sh` when you're done.
- The service is sandboxed with systemd: it can write only to `/opt/baton/data`, and can't read home
  directories or gain privileges. It isn't a container: commands an agent runs could still read the
  server process's environment, which holds the API keys. Use keys with spending limits.
- Wrong codes are rate limited (10 per 5 minutes per address).

## Troubleshooting

- **`launch.sh` says the CLI isn't signed in:** run `aws login` (or `aws configure`), then rerun.
- **HTTPS doesn't answer after the first deploy:** certificate issuance can take a minute. Check
  `ctl.sh logs`. Let's Encrypt needs ports 80 and 443 open, which `launch.sh` does.
- **First boot failed:** `ctl.sh ssh 'sudo tail -80 /var/log/cloud-init-output.log'`.
- **"UNPROTECTED PRIVATE KEY FILE" from ssh on Windows:** the key in `deploy/lightsail/.ssh/` must be readable
  only by you. In PowerShell, run
  `icacls deploy\lightsail\.ssh\baton-key /inheritance:r /grant:r "$env:USERNAME:R"`.
