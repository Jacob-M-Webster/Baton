# Deploying Baton to AWS Lightsail: instructions for an AI coding agent

You are an AI agent on a computer whose AWS CLI is already signed in. Your job: put the current `baton`
branch of this repository on an AWS Lightsail server over HTTPS, verify it works, and report the URL back
to the human. Everything you need is in this repository. Read this whole file before running anything.

The general guide, for background, is [README.md](README.md) in this folder. Repo-wide rules for AI agents
are in [/AGENTS.md](../../AGENTS.md); they apply to you too.

## Ground rules

- **Never commit, print in full, or paste into chat** any secret: API keys, `STRIPE_*` keys, the access
  code, or anything in `deploy/lightsail/server.env` or `deploy/lightsail/.ssh/`. Both paths are gitignored;
  keep it that way. When you report the access code, say it once, to the human only.
- **Don't attribute commits to yourself.** No `Co-Authored-By` trailers or "generated with" lines, and don't
  change git's `user.name`/`user.email`. Don't commit or push unless the human asks. If you have to fix a
  deploy script, tell the human what you changed and let them commit it.
- **Only touch the Lightsail resources these scripts create.** By default those are instance `baton`,
  static IP `baton-ip` and key pair `baton-key` in `us-east-1`. Don't create, change or delete anything
  else in the AWS account.
- **Ask the human before** running `teardown.sh`, creating a second instance, choosing a plan bigger than
  the default 1 GB, or using a live (`sk_live_`) Stripe key.
- **It costs money while it runs**, a flat monthly Lightsail price that `launch.sh` prints before creating
  anything. Report that price to the human.

## 1. Check the machine

You need: `git`, the AWS CLI v2, `bash`, `ssh`, `ssh-keygen`, `tar` and `curl`, plus Python 3.10+ for the
optional Stripe and test steps. On Windows, run every command below in **Git Bash**, not PowerShell (Git
for Windows provides all of these except the AWS CLI and Python).

```bash
git --version && aws --version && ssh -V && tar --version | head -1 && curl --version | head -1
aws sts get-caller-identity          # must print an account and ARN; if not, stop and ask the human
aws lightsail get-regions --query 'regions[0].name' --output text   # proves Lightsail access
```

If `get-caller-identity` fails, the CLI isn't signed in: ask the human to run `aws login` (or `aws configure`),
then continue. If the account has a named profile, use `export AWS_PROFILE=<name>` for every command below.

## 2. Get the code

The deploy uploads **the working copy as it is on disk**, so start from a clean, current checkout of the
`baton` branch of `https://github.com/Quantiset/Baton`.

```bash
# first time
git clone --branch baton https://github.com/Quantiset/Baton.git && cd Baton
# or, in an existing clone
git fetch origin && git checkout baton && git pull --ff-only origin baton

git status --short                   # should print nothing; if it doesn't, ask before deploying local edits
git log -1 --format='%h %s'          # note the commit; you'll report it
```

The built web app is committed in `web/dist`, so **you don't need Node**.

## 3. Write the server's settings

The server reads its secrets from `deploy/lightsail/server.env`. Create it from the template, with a fresh
access code:

```bash
cp deploy/lightsail/server.env.example deploy/lightsail/server.env
code="baton-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 8)"
sed -i.bak "s/^BATON_ACCESS_CODE=.*/BATON_ACCESS_CODE=$code/" deploy/lightsail/server.env && rm -f deploy/lightsail/server.env.bak
```

Then ask the human for whichever of these they want on the server, and fill them in (leave unknown ones
empty; everything still runs, and the offline demo model always works):

| Setting | What it's for |
|---|---|
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | Real models |
| `GITHUB_TOKEN` | Sessions on private GitHub repos (optional) |
| `STRIPE_SECRET_KEY` | Billing. Must be a **test** key (`sk_test_...`) unless the human says otherwise |
| `STRIPE_WEBHOOK_SECRET` | Leave empty for now; step 6 fills it in |

Settings you can pass in the environment of the scripts (all optional): `AWS_REGION` (default `us-east-1`),
`AWS_PROFILE`, `BATON_INSTANCE` (default `baton`), `BATON_RAM_GB` (default `1`), `BATON_DOMAIN`. Leave
`BATON_DOMAIN` empty unless the human gives you a domain whose DNS A record you've pointed at the static IP.
By default the site gets a free `<ip-with-dashes>.sslip.io` hostname and certificate.

## 4. Launch

Preview first. This makes no changes:

```bash
DRY_RUN=1 ./deploy/lightsail/launch.sh
```

It should print the AWS identity and say it would import key pair `baton-key` and create instance `baton`
(Ubuntu 24.04, the cheapest 1 GB plan, with its monthly price). If an instance named `baton` already exists,
**stop and ask** whether to reuse it (just run `deploy.sh`) or pick another `BATON_INSTANCE`.

Then launch for real:

```bash
./deploy/lightsail/launch.sh
```

It's safe to rerun if it stops partway; existing resources are reused. It takes about 5 to 10 minutes:

1. creates an SSH key in `deploy/lightsail/.ssh/` and imports it into Lightsail;
2. creates the instance. Its first boot (`setup-server.sh`) installs Python, Caddy, a swap file and the
   `baton` systemd service;
3. allocates and attaches a static IP, and opens ports 22, 80 and 443 (never 8000);
4. waits for first boot to finish, then runs `deploy.sh`, which uploads the code, installs it under
   `/opt/baton`, writes the Caddy HTTPS config and starts the service.

At the end it prints:

```
  Baton is live at   https://A-B-C-D.sslip.io
  Access code        baton-xxxxxxxx
  One-tap join link  https://A-B-C-D.sslip.io/?code=baton-xxxxxxxx
```

## 5. Verify

```bash
url="$(./deploy/lightsail/ctl.sh url)"; base="${url%%/?code=*}"
curl -fsS "$base/api/access"                  # {"required":true,"ok":false,"code":null}
curl -s -o /dev/null -w '%{http_code}\n' "$base/api/sessions"   # 401: locked without the code
curl -fsS -H "X-Baton-Access: ${url##*code=}" "$base/api/models" | head -c 300; echo   # lists providers
./deploy/lightsail/ctl.sh status              # baton and caddy both "active (running)"
```

If `https://` doesn't answer for the first minute or two, Caddy is still getting the certificate. Wait,
then check `./deploy/lightsail/ctl.sh logs`.

Optional browser check (needs Python and `pip install playwright && python -m playwright install chromium`):

```bash
python scripts/e2e_mobile.py --url "$base" --code "${url##*code=}" --out /tmp/baton-shots
```

It should print `OK: judges join from a phone, request changes, and steer on an open floor`.

## 6. Stripe webhook (only if `STRIPE_SECRET_KEY` is set)

Subscribing works without this step. The webhook keeps Baton current when someone cancels in Stripe's
portal or a renewal fails.

```bash
python -m venv .venv && . .venv/bin/activate 2>/dev/null || . .venv/Scripts/activate
pip install -q -r requirements.txt
STRIPE_SECRET_KEY="$(sed -n 's/^STRIPE_SECRET_KEY=//p' deploy/lightsail/server.env)" \
  python scripts/stripe_setup.py webhook "$base"
```

It prints `STRIPE_WEBHOOK_SECRET=whsec_...`. Put that value in `deploy/lightsail/server.env`, then redeploy:

```bash
./deploy/lightsail/deploy.sh
```

Optional proof that billing recurs (test keys only; makes and then deletes a throwaway test customer):

```bash
STRIPE_SECRET_KEY="$(sed -n 's/^STRIPE_SECRET_KEY=//p' deploy/lightsail/server.env)" python scripts/stripe_setup.py renewal
```

## 7. Report back to the human

Tell them, in one message:

- the URL (`https://….sslip.io`) and the one-tap join link from `./deploy/lightsail/ctl.sh url` (it contains
  the access code; that's expected, since judges scan it);
- the AWS region, instance name, static IP and the monthly price `launch.sh` printed;
- which model keys and Stripe settings are configured (names only, never values);
- the commit you deployed (`git log -1 --format='%h %s'`);
- anything that failed or that you changed, with the exact error text.

## Later: updating, operating, removing

| Task | Command |
|---|---|
| Deploy new code | `git pull --ff-only origin baton && ./deploy/lightsail/deploy.sh` (sessions survive) |
| Follow logs | `./deploy/lightsail/ctl.sh logs` |
| Status, disk, memory | `./deploy/lightsail/ctl.sh status` |
| Restart | `./deploy/lightsail/ctl.sh restart` (running sessions resume from their log) |
| Shell on the server | `./deploy/lightsail/ctl.sh ssh` (user `ubuntu`, sudo works) |
| Back up all sessions | `./deploy/lightsail/ctl.sh backup` |
| Delete everything | `./deploy/lightsail/teardown.sh`. **Only when the human asks**; it stops billing and loses sessions |

The SSH key and `server.env` exist only on the machine that ran `launch.sh`. To operate the server from
another machine, the human has to copy `deploy/lightsail/.ssh/` and `deploy/lightsail/server.env` there
privately (never through git).

## If something goes wrong

The server-side scripts (`setup-server.sh`, `remote-install.sh`) were written and syntax-checked but this is
their first run on a real Lightsail instance, so failures there are the most likely. Diagnose before you
change anything:

| Symptom | Look at |
|---|---|
| `launch.sh` times out waiting for first boot | `./deploy/lightsail/ctl.sh ssh 'sudo tail -80 /var/log/cloud-init-output.log'` |
| `deploy.sh` fails during install | the printed output; then `./deploy/lightsail/ctl.sh ssh 'sudo journalctl -u baton -n 80 --no-pager'` |
| Service starts, then exits | `journalctl -u baton` (as above). The service may only write under `/opt/baton/data` (systemd `ProtectSystem=strict`); a "Read-only file system" error means something writes elsewhere |
| HTTPS never answers | `./deploy/lightsail/ctl.sh ssh 'sudo journalctl -u caddy -n 60 --no-pager'`; ports 80 and 443 must be open: `aws lightsail get-instance-port-states --instance-name baton` |
| `ssh` says "UNPROTECTED PRIVATE KEY FILE" (Windows) | in PowerShell: `icacls deploy\lightsail\.ssh\baton-key /inheritance:r /grant:r "$env:USERNAME:R"` |
| `aws` errors about permissions | the account needs Lightsail permissions; ask the human |

If you fix a script, keep the fix minimal, rerun the step, and report the diff to the human. Don't commit it
yourself (see Ground rules).
