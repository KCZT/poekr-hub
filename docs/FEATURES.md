# Poker Hub — Features

Everything the app does, grouped by where you meet it. For *why* it works this
way, see REQUIREMENTS.md.

---

## Getting in

**Accounts.** Username, display name, and a password only if you want one. The
first account created on a fresh install becomes the poker admin. Self sign-up
can be switched off, after which only the poker admin creates accounts.

**Signing in by tapping your name.** Accounts without a password appear on the
sign-in screen as a grid of faces — tap yours and you are in. No typing, which is
the right amount of ceremony for a game where everyone is in the same room. Add a
password later from the You tab and the account switches to the normal form;
remove it and it goes back. A poker admin can do the same to anyone's account,
and the account list shows at a glance who has one.

**PIN for the shared laptop.** Somewhere between the two: set a 4–8 digit PIN and
tapping your name asks for it. Works with or without a password behind it. The
PIN works only on that screen — everywhere else still wants the real password, if
you have one.

**Guessing protection.** Passwords, PINs and table passwords all back off after
four misses, then for 5s, 15s, 1m, 5m, 15m. Counted strictly per account and
loosely per device, so nobody can lock anyone else out and the shared laptop
survives one person fumbling.

**Staying signed in.** Sign-ins are kept on disk, so restarting the app mid-game
does not sign the table out. Only a hash is stored.

---

## Tables

**Multiple rooms at once.** Each gets a five-character join code and a QR code.
People can be in more than one.

**Joining.** Scan the QR, type the code, or follow a shared link. Optional table
password. A room admin can also seat a guest who has no account at all.

**Roles.** The person who opens the table runs it and can promote others. Room
admins approve buy-ins, cash people out, switch games, run the settle-up and
close the night.

**Seating and the button.** Drag people into the order they are actually sitting
in, or use the arrows. The dealer button shows on the seat and passes to the next
person still sitting down.

**Table settings.** Standard buy-in, smallest allowed, the step buy-ins go in,
who holds the cash, whether short buys and credit are allowed, whether players
can buy in without approval, whether debts carry to the next night, and the table
password.

---

## Money

**Buy-ins record how they were paid.** Cash into the box, on credit, or someone
else fronting it. The three settle differently and the app asks once rather than
guessing.

**Short buys.** Three numbers per table — standard, smallest allowed, step.
At or above standard goes straight through. Between smallest and standard is a
short buy: allowed outright, or held for one-tap approval, depending on the
table. Below the smallest is refused with a reason. Amounts are exact, so a $37
buy-in is $37.

**Approval queue.** Anything needing a room admin's nod appears at the top of
their screen with the amount, who asked, and why it was flagged.

**Cash-outs.** Count the chips, type the total, see the night's result before
committing. If the box is empty, turn off "cash handed over now" and what they
are owed carries into the settle-up instead of vanishing.

**Money out of the pot.** Pizza, drinks, tips, the host's cut. Three questions:
who gets the money, who is paying it now, and who splits it. Chips are never
touched, so they still reconcile at the end. Odd cents always add up.

**The ledger.** Every entry, visible to everyone, exportable as CSV. A room admin
can strike out a mistake — the totals correct everywhere and the record of the
mistake stays.

**Settle-up.** The fewest payments that square everybody, not a list of every
obligation. Repayments for fronted buy-ins are routed back to the person who
fronted them and labelled as such. If chips do not reconcile it says so by name
and amount before you can close.

**Standing balances.** Whatever is not paid becomes a balance between two people.
It shows on both cards, carries into the next night's settle-up, and either can
mark it paid — with an undo, in case that was a thumb rather than a decision.
Payment app links are one tap for anyone who has added a handle.

**Reopening a night.** Somebody miscounted and it came out afterwards. A room
admin reopens from the settle-up panel: the night goes back to running, comes off
lifetime stats, and the debts it created are taken back off. Fix it, close it
again. A closed night refuses new buy-ins, cash-outs and spending until reopened.

---

## Games

**Six variants:** Texas hold'em, pot limit Omaha, seven card stud, short deck,
dealer's choice, and blackjack.

**Switching mid-night.** Start on hold'em, break for blackjack, go back. Chips
and money never move. Each stretch is recorded separately, so results are
attributed per game and you can see how you do at each.

Blinds and antes are shown as a reminder of what you agreed to play. The app does
not move them — that is done at the table.

---

## People

**Player cards.** Tap any face anywhere. Record, nights played, win rate, return,
best and worst night, a running graph, badges, how you two have done at the same
tables, and whether money is owed either way. It is the one object in the app
that looks like a thing rather than a screen.

**One person's night.** Tap a seat and see everything that touched them in order
— sat down, bought in, rebought, their share of the pizza, cashed out — with
their running position after each event. The screen to open when someone says a
number is wrong.

**Profile pictures.** Any photo, resized in the browser before upload, with the
right way up preserved. Anyone without one gets a coloured initial and a suit.

**Time at the table.** Counted per person and only while the game is running, so
someone who turns up for the last hour is not credited with the whole night.

**Badges.** Eleven of them — first night, regular, fixture, in the black,
century, on a heater, iron man, never rebought, comeback, dealer's choice, and
two for how you handle the shot.

**Guests.** A room admin can seat someone with no account. Their results still
count, and a poker admin can merge them into a real account later without losing
anything.

---

## Standings

All-time, this year, 90 days or 30 days. Rank by net, per night, win rate,
return, per hour, nights played or best night. Filter to one game or all of them.

---

## The shot

Anyone at the table can call one on anyone, with an optional reason. The person
called has two ways out and both are counted: take it, or refuse and post a photo
with it. The photo lands in the night's gallery. There is a running tally so the
argument about who has dodged the most has an answer, and it carries onto
everyone's card.

Renameable per table, or switch it off entirely.

---

## During the night

**Live updates.** Every phone updates on its own. No pull-to-refresh.

**Alerts.** Your phone buzzes when a shot is called on you, someone calls out, or
a buy-in needs your approval. On an iPhone they only arrive once the app is on
the home screen, which is an Apple rule rather than a choice here — the You tab
says so rather than showing a switch that would do nothing. No internet and no third party involved — it rides
the connection the app already holds open. Needs the secure link and the app
still open, though backgrounded is fine.

**Calling out.** Send a line to the whole table. It buzzes, shows, and reads
aloud.

**Custom sounds.** Anyone can upload clips. A room admin maps them to buy-ins,
cash-outs, the game switching, shots and so on. Set a personal walk-up sound that
plays when you sit down. Built-in chimes cover anything unmapped, and there is a
mute button in the header.

**Photos.** A gallery per night, with refusals filed alongside.

**Screen stays awake** while a game is running.

---

## Sharing

Three kinds of read-only link that need no sign-in, each revocable:

- A room's leaderboard, live during the game or final afterwards.
- The all-time standings.
- Your own stat card.

---

## Admin

**Accounts.** Create, rename, change username, promote to poker admin, switch off,
delete, or merge a duplicate or guest into a real account without losing history.

**Password resets.** Sets a new one and signs them out everywhere.

**Stat corrections.** Fix any lifetime number. Stored as a correction with a
reason and your name, never as an overwrite, so the game history stays intact,
the card shows it was adjusted, and it can be undone.

**Standing balances.** See everything owed across the group and clear any of it.

**Activity log.** Every privileged action with who did it and when.

**Name and logo.** What the install is called and the mark it wears, both owned
by the poker admin. Upload a square PNG or SVG — anything else is fitted into a
square — and it becomes the sign-in screen mark, the browser tab icon, the
home-screen icon and the badge on every alert. The name follows to the browser
tab, the header, the home-screen name and the filename of backups. A bundled mark
is used until someone replaces it, and "use the default" puts it back.

**Site settings.** Currency, default buy-ins, whether people can sign themselves
up, whether debts carry between nights.

**Backup.** One button, one zip: every account, night, ledger entry and photo,
with a note inside explaining how to put it back.

---

## Running it on a server

**Hosted mode.** Set one variable, `PUBLIC_URL`, and the app changes posture as a
unit: reading a table needs a sign-in and membership, it binds to loopback so
nothing reaches it except the proxy, it believes the proxy about who is asking,
and it stops managing its own certificate. Unset it and the laptop behaviour
comes back.

Passwords stay optional there too, so a table can move to a server without
locking anyone out. The startup banner spells out what that means on a public
address, and says so louder if a poker admin is one of the open accounts.
`REQUIRE_PASSWORDS=1` insists on one.

**Caddy config included.** `Caddyfile.example` has the two settings that matter —
unbuffered live updates, and forwarding the real client address so rate limiting
still works per person.

**Getting back in.** `npm run set-password <username>` from a shell on the
machine, for the case where an install with no passwords moves somewhere that
needs them.

See **docs/HOSTING.md** for the whole walkthrough.

## Browsers and phones

**Works on** Safari on iPhone and Mac, Firefox anywhere, and anything Chromium,
from Safari 15.4 and Firefox 91 upward.

**Degrades rather than breaks.** Vibration, wake lock, app badges, Web Share and
notifications are all absent on some engine or other. Where one is missing the
app carries on without it and, where it matters, says why — an iPhone is told
that alerts need the app on the home screen instead of being shown a switch that
would do nothing.

**Built for a phone at a table.** Nothing scrolls sideways from 360px up, every
control a finger is meant to hit is at least 44px on a touchscreen, and the
layout clears the Dynamic Island and the home indicator on every iPhone from the
14 Pro onwards. Tested at eight sizes from an SE to a 16 Pro Max.

## Under the hood

**Runs offline.** Once started, nothing needs the internet.

**HTTPS out of the box.** Makes its own certificate on first run so phones get a
secure context, which is what notifications, home-screen install and offline mode
require. Browsers warn once per device because the certificate is self-signed;
tap through and it never asks again. The plain HTTP link still works for
everything else.

**Installs to a home screen** and works offline once loaded.

**Tests are safe to run anywhere**, including on the server holding your history:
each suite writes to a throwaway directory rather than the live one.

**Storage** is JSON files plus an uploads folder. Copy two folders to back up.
Writes are atomic and a corrupted file is quarantined rather than crashing.

**Two dependencies:** express and qrcode, plus selfsigned for the certificate.
The ZIP writer for backups is written in-house rather than pulling another one.

---

## Deliberately not included

- Dealing, hand histories, hole cards, or anything that knows the rules of poker.
- Blind timers and tournament clocks.
- Chip counting by denomination.
- Actual money transfer.
- Anything requiring an account on a server you do not own.

## Known gap

**On a local network,** reading a room needs no credentials: anyone on the wifi
with a room code can see its state, ledger, settle-up and CSV export without
signing in. The table password gates joining, not looking. That is deliberate for
friends in a house.

**Hosted, this is closed** — reads need a sign-in and only people at the table
can read it. Still true either way: anyone signed in can see everyone's card and
the standings, which suits a group who know each other.
