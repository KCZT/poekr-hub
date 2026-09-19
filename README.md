# Poker Hub

A home poker night tracker you run yourself. Buy-ins, cash-outs, multiple rooms,
who owes who, and a settle-up at the end that is short enough to actually follow.

Runs on one computer at the table. Everyone else joins from their phone over the
same wifi. No accounts on someone else's server, and no internet needed once it
is running.

There are three companion documents:

- **[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)** — what this has to do, what it
  runs on, and the rules the money model is not allowed to break. Read it before
  changing anything.
- **[docs/FEATURES.md](docs/FEATURES.md)** — everything it does, in one list.
- **[docs/HOSTING.md](docs/HOSTING.md)** — putting it on a server behind Caddy,
  and what changes about the app when you do.

---

## Getting it running

You need [Node.js](https://nodejs.org) (the LTS button). Then:

- **Windows** — double-click `start.bat`
- **Mac** — double-click `start.command`
- **Linux** — `./start.sh`

First run installs dependencies and takes a minute. After that it opens straight
away. The window that opens prints two addresses:

```
This computer   http://localhost:3000
Everyone else   https://192.168.1.24:3443
```

Give the second one to the table, or let them scan the QR code on the room
screen — it points at the same place.

### The certificate warning

The first time someone opens that link their phone will say the connection is
not private. That is expected and it is not a problem. It means the certificate
was made by the computer running this rather than bought from a company, which
is the only option for something on your own wifi with no domain name.

Tell them to tap **Advanced** and then **Proceed** (Chrome) or **Show details**
and **visit this website** (Safari). Once per phone, then never again.

It is worth doing rather than using the plain `http://` link, because browsers
switch off three things outside a secure connection:

- alerts, which is how someone knows a shot was called on them or a buy-in needs
  approving,
- adding the app to a home screen,
- working offline if the wifi drops.

None of those work on the plain link for anyone except whoever is sitting at the
host computer, where `localhost` counts as secure. The plain link is still there
and everything else on it works fine.

**The first account you create becomes the poker admin.** Make it yours.

Want to look around with data in it first? Run `npm run seed` — six fake nights,
six accounts, all with the password `password1`.

---

## The two admin roles

These are deliberately separate. One is about the website, one is about a game.

**Poker admin** (the webmaster). Site-wide, set per account.
Create and delete accounts, reset passwords, change roles, correct anyone's
lifetime stats, merge duplicate or guest accounts into real ones, clear standing
debts, delete rooms, change site defaults. Everything they do lands in an
activity log with their name on it. Under the Admin tab.

**Room admin.** One table only, set per room, and there can be several.
Start the night, approve buy-in requests, buy in or cash out on someone's behalf,
switch the game, strike out a mis-typed ledger entry, set the table password and
limits, pick the table sounds, remove someone, close the night.

A room admin has no access to the Admin tab. A poker admin can run any room.

---

## The money model

This is the part the old version got wrong, so here is what it actually does.

Every entry is a fact about cash or chips. From those, two different numbers get
worked out, and confusing them is what causes arguments:

- **Result** — chips cashed out minus chips bought. "Did I win tonight?"
- **Remaining** — result plus whatever cash has already changed hands.
  "Do I still owe anyone?"

`Remaining` sums to zero across the table, which means it can be collapsed into
the smallest possible set of payments. Five people with a tangle of IOUs usually
comes out as two or three payments.

### Instead of "loans" and "IOUs"

Every buy-in records **how it was paid**, because these settle differently:

| | What it means | How it settles |
|---|---|---|
| **Paying cash** | Money in the box now | Nothing owed |
| **On credit** | Chips now, money later | Owed at the end |
| **Someone's covering me** | Another player puts the cash in | You pay *them* back, not the table |

That last one matters. If Dev fronts Sam's buy-in, the settle-up routes Sam's
payment straight back to Dev, labelled "paying back the buy-in they fronted" —
not to whoever happens to be up the most.

### The cash box is a player too

One person at the table holds the cash. If more gets paid out of the box than
went into it — which happens the moment anyone plays on credit — that person
covered the difference out of their own pocket, and the settle-up pays them back.
Pick who holds it under Room settings; it defaults to whoever opened the table.

Without this the numbers do not add up and money ends up belonging to nobody. It
is why the old version's totals drifted.

### Buying in short

Instead of a fixed buy-in you have to fight, each table sets three numbers: a
**standard** buy-in, the **smallest allowed**, and a **step** amount.

Anything at or above the standard goes straight through. Anything between the
smallest and the standard is a *short buy*, and the table decides what happens:
allowed outright, or held for one tap of approval from the room admin. Below the
smallest is refused with a reason. Amounts are tracked exactly — a $37 buy-in is
$37, not "one and a bit stacks".

### Money that leaves the pot

Pizza, drinks, tips, your cut for hosting. "Money out" records it as cash, which
is the important bit — chips are not touched, so they still have to reconcile at
the end, and the spend shows up in the settle-up instead of quietly making
someone short.

Three questions, because the answers settle differently:

- **Who gets the money** — someone outside the game, or a player.
- **Who is paying it now** — the cash box, a person out of their own pocket, or
  nobody yet, settle it at the end.
- **Who splits it** — everyone by default, untick whoever arrived late.

Uneven cents go to the first person on the list so the shares always add up to
the exact amount.

### Cashing out when there is no cash left

Turn off "cash handed over now" when the box is empty. The result still counts,
and what they are owed carries into the settle-up instead of quietly vanishing.

### Standing balances

Whatever is not paid on the night becomes a balance between two people. It shows
on both their cards, carries into the next night's settle-up, and either of them
can mark it paid, with an undo in case that was a thumb rather than a decision.
Payment app links are one tap if they have added a handle.

An old debt carried into a night is folded into that night's settle-up, so what
you see there is the running total rather than just tonight's damage. Closing the
night replaces the old figure rather than adding to it — a night where nobody
won or lost anything leaves a standing debt exactly where it was.

### Fixing a night after you have closed it

Someone miscounted a stack and it only came out afterwards. A room admin can
reopen the night from the settle-up panel: it goes back to running, comes off
everyone's lifetime stats, and any debts it created are taken back off. Fix the
numbers, close it again.

It reverses the exact figures that closing applied rather than recalculating, so
if someone has settled up in the meantime that payment is not silently trampled
— it shows as money owed the other way until you close again. A closed night
refuses new buy-ins, cash-outs and spending until it is reopened.

---

## Everything else

**The shot** — anyone at the table can call one on anyone. The person called
either takes it, or they don't and post a photo with it instead. Both get
counted, both go on their card, and the photo lands in the night's gallery.
There's a running tally so the argument about who has dodged the most has an
answer. Rename it or switch it off per table in Room settings.

**Seating and the button** — drag people into the order they're actually sitting
in, or use the arrows, which is faster on a phone. The dealer button shows on the
seat and passes to the next person still sitting down.

**Alerts** — your phone buzzes when a shot is called on you, someone calls out,
or a buy-in needs your approval. They ride the connection the app already holds
open, so nothing goes near the internet and no third party is involved. Two
conditions: you have to be on the secure link, and the app has to still be open,
though backgrounded is fine. Turn them on under You, which will tell you if you
are on the wrong link and hand you the right one.

**One-button backup** — Admin gets a "Download a backup" button that gives you a
single zip with every account, night, ledger entry and photo, plus a note inside
explaining how to put it back. Keep a copy somewhere that isn't the laptop.

**Rooms** — as many at once as you like. Five-character join code, QR code, and
an optional table password. People can be in more than one.

**Switching games mid-night** — start on hold'em, break for blackjack, go back.
Chips and money never move; each stretch is recorded separately so you can see
how you do at each game. Hold'em, PLO, seven card stud, short deck, dealer's
choice and blackjack. Blinds are your business, not the app's — it tracks money,
you run the table.

**One person's night** — tap a seat to see everything that touched them in
order: sat down, bought in, rebought, their share of the pizza, cashed out, with
their running position after each one. This is the screen to open when someone
says a number is wrong, because it answers how they got there rather than just
what the total is.

**Player cards** — tap any face anywhere. Record, nights, win rate, return, best
and worst night, a running graph, badges, head-to-head against you, and whether
money is owed either way. It is the one thing in the app that looks like an
object rather than a screen, which is the point.

**Profile pictures** — pick any photo, it gets resized in the browser before
upload. Accounts without one get a coloured initial and a suit.

**Guessing protection** — passwords, PINs and table passwords all back off after
a handful of misses, then for longer and longer. Counted per account, so nobody
can lock anyone else out, and loosely per device so the shared laptop still works
when one person fumbles their own PIN.

**Staying signed in** — sign-ins are kept on disk, so restarting the app does not
sign the whole table out mid-game. Only a hash of each one is stored, which is
why backups cannot be used to walk into anyone's account.

**Passwords are optional** — accounts without one sign in by having their name
tapped, which is the right amount of ceremony when everyone is in the same room.
Add or remove one at any time. On a shared laptop
at the table you can also set a short PIN, tap your face, and punch it in. The
PIN only works on that screen; everything else still wants the real password.

**Guests** — a room admin can seat someone with no account. Their results still
count, and a poker admin can merge them into a real account later without losing
anything.

**Sharing** — three kinds of read-only links that need no sign-in: a live or
final room leaderboard, the all-time standings, and your own stat card. Each one
can be switched off again, which kills the link.

**Custom sounds** — anyone can upload clips. A room admin maps them to buy-ins,
cash-outs, shots being called, the game switching, and so on. You can set a personal
walk-up sound that plays when you sit down. Built-in chimes cover anything
unmapped, and there is a mute button in the header.

**Live updates** — every phone updates on its own, no pull-to-refresh.

**Calling out** — send a line to the whole table. It buzzes, shows, and reads
aloud.

**Photos** — a gallery per night.

**Stat corrections** — a poker admin can fix any lifetime number. It is stored as
a correction with a reason and their name, never as an overwrite, so the game
history stays intact, the card shows it was adjusted, and it can be undone.

**Ledger** — every entry visible, exportable as CSV, and a room admin can strike
out a mistake without deleting the record of it.

**Time at the table** — counted per person, and only while the game is actually
running, so someone who turns up for the last hour is not credited with the whole
night. That is what the per-hour figures are built on.

**Make it yours** — the poker admin sets the name and uploads a logo from the
Admin tab. Both follow through to the sign-in screen, the browser tab, the
home-screen icon and every alert.

**Also** — installs to a phone home screen, keeps the screen awake during a game,
works offline once loaded, and the tab bar becomes a side rail on a desktop. The
first three need the secure link.

---

## Where your data lives

Everything is JSON files in `data/`, and uploads are in `uploads/`. That is the
whole database. Copy those two folders to back up, drop them somewhere else to
move the app. Passwords are salted and hashed with scrypt, and no password or PIN
is ever sent to a browser.

`data/cert/` holds the certificate and its private key. It is left out of
backups on purpose, it never leaves the machine, and a new one is made
automatically if you move to a different network.

If you update the app, do not overwrite `data/` — that is your history.

---

## Checking it still works

```
npm test               # money model, the whole HTTP API, and compatibility
```

That runs with nothing installed beyond the app's own two dependencies. The rest
drive real browsers, so they want `npm install --no-save puppeteer` first:

```
npm run test:ui        # the real interface, clicked through a full night
npm run test:layout    # geometry on eight phones, from an SE to a 16 Pro Max
npm run test:degraded  # the app on engines missing APIs: iOS Safari, Firefox
npm run test:webkit    # a real WebKit build — the engine behind Safari
npm run test:secure    # that a phone on the wifi gets a working secure context
npm run test:hosted    # that a public address closes what it claims to close
```

`test:webkit` additionally wants a WebKit to drive:

```
sudo apt-get install -y webkit2gtk-driver xvfb
```

Every suite skips politely rather than failing when its tooling is absent.

**The tests never touch your data.** Each one writes to a throwaway directory and
deletes it afterwards, so running them on the machine holding your poker history
is safe — including on a live server. They are repeatable too: run them twice in
a row and the second run behaves exactly like the first.

### What each one is actually for

The money tests are the ones worth keeping. They run a cash night, a credit
night, a fronted buy-in, a deliberately messy night, short-buy policy,
struck-out entries, debt carried from a previous night, and five ways of
spending money out of the pot — and check that everybody ends at exactly zero
every time.

The browser suites exist because of a specific failure. A single
`Notification?.permission` at the top of a module threw on every iPhone and
turned the app into a blank page, and nothing caught it: Chromium has
`Notification`, so the interface tests sailed through. So there are now three
different angles on the same question, because no one of them is enough:

- **`test:degraded`** takes APIs away and plays a night without them. This is
  the one that catches the blank page.
- **`test:webkit`** runs the genuine Safari engine. It catches what an engine
  disagrees about — parsing, layout, CSS — but *not* the iOS bug, because the
  WebKit you can install on Linux still has `Notification` and iOS Safari does
  not.
- **`test:compat`** reads the source against what each target browser supports.
  This is how Firefox is covered at all, since its builds are not obtainable
  everywhere, and it is the only one that can see a hazard on a line that never
  runs during a test.

## If something goes wrong

**Phones cannot reach it.** They need to be on the same wifi, not mobile data. On
Windows, say yes to the firewall prompt the first time. Corporate and guest
networks often block devices from seeing each other — a phone hotspot works.

**"That file is too big."** Pictures are resized automatically; sounds are capped
at 3MB.

**Sounds do not play on a phone.** Browsers need one tap on the page first. Tap
anything.

**Someone forgot their password.** Admin tab, find them, reset it.

**"Too many tries."** Somebody has been guessing at that account. Wait out the
time it names, or a poker admin can reset the password from the Admin tab, which
lets them straight back in.

**Nothing loads on an iPhone, just a blank page.** That was a bug, fixed — make
sure you are running a copy from September 2026 or later. If a blank page comes
back, open the same address on another phone or a laptop to narrow it down, and
check whether you are on the plain `http://` link with a certificate the phone
has not been told to trust: iOS is stricter about self-signed certificates than
Android is, and will refuse rather than warn. On a hosted install behind Caddy
the certificate is real and this does not arise.

**Alerts do not arrive.** Check you opened the `https://` link and not the plain
one — the You tab will say so and give you the right link. They also need the app
still open, even if backgrounded, and permission granted. iPhones only allow them
once the app has been added to the home screen.

**The certificate warning came back.** The certificate is tied to the computer's
address on the network. If it moved to different wifi and got a new address, a
new certificate is made and phones ask once more.

**The numbers look wrong.** Open the ledger and look for a double entry — striking
it out fixes the totals everywhere. If chips do not reconcile, the settle-up says
so and names the amount before you close the night.
