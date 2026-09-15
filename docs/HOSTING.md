# Hosting it on a server

The app is built for a laptop on the table. It will also run on a server behind
Caddy, which gets you a real certificate, no warning on people's phones, and an
address that works from anywhere.

**Read this first, because the trade is real.** On your wifi, the people who can
reach the app are the people in your house. On a public address that is no longer
true, so setting `PUBLIC_URL` changes the app's posture in three ways at once:

- Reading a table needs a sign-in, and only people at that table can read it.
- An account without a password stops being a way in.
- The app stops managing its own certificate, because Caddy is doing it properly.

You do not switch those on individually and you cannot half-do it. One variable
moves all three together.

---

## Before you start

You need a domain name pointed at the server's IP, and a server. The smallest
box any provider sells is plenty — this is a few JSON files and a handful of
people.

If your poker night currently runs with no passwords, **that has to change**.
Everyone needs one before they can sign in. Set them with
`npm run set-password <username>`, which is also how you get back in if you lock
yourself out.

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

Unset `PUBLIC_URL` and it is the LAN app again: open reads, optional passwords,
its own self-signed certificate. Passwords already set stay set.

---

## What is still true on a public address

Every account can read every other account's card and the standings, and the
player list is visible to anyone signed in. That is the same as on your wifi and
fine for a group who know each other — worth knowing before you hand the address
to a wider circle.

Shared links stay public on purpose. Each one is a long unguessable token, is
read-only, and can be switched off from inside the app, which kills the link.
