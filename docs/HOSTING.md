# Hosting it on a server

The app is built for a laptop on the table. It will also run on a server behind
Caddy, which gets you a real certificate, no warning on people's phones, and an
address that works from anywhere.

**Read this first, because the trade is real.** On your wifi, the people who can
reach the app are the people in your house. On a public address that is no longer
true, so setting `PUBLIC_URL` changes the app's posture in three ways at once:

- Reading a table needs a sign-in, and only people at that table can read it.
- The app stops managing its own certificate, because Caddy is doing it properly.
- The addresses it hands out, and the QR code, point at your domain.

You do not switch those on individually and you cannot half-do it. One variable
moves all three together.

---

## Before you start

You need a domain name pointed at the server's IP, and a server. The smallest
box any provider sells is plenty — this is a few JSON files and a handful of
people.

**Passwords stay optional**, the same as on your wifi. Accounts without one sign
in by having their name tapped, and that keeps working on a public address.

Be clear about what that means, because it is the one thing about hosting that
can genuinely catch you out: anyone who finds the address can sign in as any
account that has no password. If one of those is a poker admin, they can manage
every account and download a backup of everything. Reading a table needs a
sign-in, but signing in is the part that is free.

Three ways to sit with that, all reasonable:

- **Leave it open.** Nobody is looking for your poker site. Give the admin
  account a password and leave the players open, which is the middle most people
  want.
- **Give everyone a password.** `npm run set-password <username>` on the server,
  or from the Admin tab once you are in.
- **Insist on it.** Add `Environment=REQUIRE_PASSWORDS=1` to the service file
  below and accounts without one cannot sign in at all.

`npm run set-password` is also how you get back in if you lock yourself out.

---

## 1. Put the app on the server

```bash
sudo adduser --system --group --home /opt/poker poker
sudo -u poker git clone <your-repo> /opt/poker/app   # or scp the folder up
cd /opt/poker/app
sudo -u poker npm install --omit=dev
```

Bringing an existing table with you? Copy `data/` and `uploads/` across. Leave
`data/cert/` behind — it belongs to the old machine and Caddy handles
certificates now.

---

## 2. Run it as a service

`/etc/systemd/system/poker.service`:

```ini
[Unit]
Description=Poker Hub
After=network.target

[Service]
Type=simple
User=poker
WorkingDirectory=/opt/poker/app
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=PUBLIC_URL=https://poker.example.com
# Uncomment to insist every account has a password:
# Environment=REQUIRE_PASSWORDS=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

# It only needs its own folder.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/poker/app/data /opt/poker/app/uploads

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now poker
sudo journalctl -u poker -f
```

`PUBLIC_URL` is the whole thing. With it set the app binds to `127.0.0.1` only,
so nothing reaches it except through Caddy, and it prints what it has locked down
on startup.

---

## 3. Point Caddy at it

Copy `Caddyfile.example` to `/etc/caddy/Caddyfile`, change the domain, then:

```bash
sudo systemctl reload caddy
```

Caddy gets the certificate, renews it, and redirects http to https without being
asked. The two settings in that file worth understanding:

- **`flush_interval -1`** keeps the live-update stream unbuffered. Without it
  every table looks frozen until something else forces a flush.
- **`X-Forwarded-Proto` and `X-Forwarded-For`** are how the app knows the request
  arrived over https and who sent it. Drop them and the app hands out broken
  links, and the rate limiter treats the entire internet as one visitor sharing
  one budget of guesses.

---

## 4. Make the first account yours

Open the address and sign up **before you give it to anyone**. The first account
created becomes the poker admin, and on a public URL that is whoever gets there
first.

If you brought an existing database, give yourself a password on the server:

```bash
sudo -u poker npm run set-password riley
```

---

## Keeping it alive

**Backups.** The Admin tab gives you everything in one file. `data/` and
`uploads/` are the whole database if you would rather copy folders.

**Updating.** Pull, `npm install --omit=dev`, `sudo systemctl restart poker`.
Never overwrite `data/` — that is your history.

**One process only.** The store keeps its state in memory and writes it out, so
two copies pointed at the same folder will quietly overwrite each other. Do not
add workers, do not run a second instance.

---

## Going back to a laptop

Unset `PUBLIC_URL` and it is the LAN app again: open reads and its own
self-signed certificate. Passwords already set stay set.

---

## On iPhones

Everything works in Safari as it is. Two things are worth telling people:

- **Alerts need the app on the home screen.** iOS only allows notifications to
  an installed web app, so tap the share button, then "Add to Home Screen", and
  open it from there. The app says as much on the You tab.
- Installed to the home screen it also runs full-screen and keeps working if the
  wifi drops.

## What is still true on a public address

Every account can read every other account's card and the standings, and the
player list is visible to anyone signed in. That is the same as on your wifi and
fine for a group who know each other — worth knowing before you hand the address
to a wider circle.

Shared links stay public on purpose. Each one is a long unguessable token, is
read-only, and can be switched off from inside the app, which kills the link.
