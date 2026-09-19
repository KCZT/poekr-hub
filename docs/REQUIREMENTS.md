# Poker Hub — Requirements

What this software has to do, what it has to run on, and the rules it is not
allowed to break. Written to be read before changing anything.

---

## 1. What it is for

A group of friends plays poker at someone's house. Money moves all night: people
buy in, rebuy, borrow off each other, order food, cash out. At the end somebody
tries to reconstruct it from memory and there is an argument.

This is the record that stops the argument. It tracks money, not cards. It has
no opinion on who won a hand, does not deal, does not know the rules of poker,
and never touches a pot mid-hand. It knows how much went in, how much came out,
and who still owes who.

**Primary job:** at the end of the night, produce a short list of payments that
squares everybody, and be trusted enough that nobody argues with it.

Anything that does not serve that job is optional. Anything that could make that
list wrong is a defect, not a feature request.

---

## 2. Who uses it

| | Who | What they do |
|---|---|---|
| **Player** | Everyone at the table | Joins, buys in, cashes out, looks at their own numbers |
| **Room admin** | Whoever is running that table | Approves buy-ins, cashes people out, switches games, closes the night |
| **Poker admin** | Whoever owns the install | Manages accounts, corrects stats, changes site settings, sets the name and logo |

The two admin roles are deliberately separate. A room admin runs one game and
cannot touch accounts. A poker admin runs the site and has no special standing at
any particular table beyond being able to step in. Both roles can be held by the
same person, and usually are.

**Requirement:** a room admin must never be able to reach account management, and
the split must hold at the API, not only in the interface.

**Requirement:** the install belongs to whoever runs it, not to whoever wrote it.
The name and logo are set by the poker admin from inside the app — no file
editing — and both must reach every surface: sign-in screen, browser tab, page
title, home-screen icon and name, notification badge, and backup filenames. A
sensible default ships so a fresh install is never blank.

---

## 3. Where it runs

The app runs in one of two postures, and setting `PUBLIC_URL` is what moves it
between them. They are not a set of independent switches, because the failure
mode of independent switches is someone getting half of them right.

| | On a local network | Hosted |
|---|---|---|
| Reading a table | open to anyone who can reach it | signed-in members only |
| Accounts without a password | allowed, sign in by tapping a name | still allowed, and still a way in |
| Certificate | makes its own, warns once per device | Caddy's, no warning |
| Listens on | every interface | loopback only |
| Client addresses | taken from the connection | taken from the proxy's headers |

**Requirement:** a public address must never inherit the local network's
assumption that whoever can reach the app belongs there — *except* where the
owner has knowingly chosen otherwise. Passwordless accounts are that exception:
they stay available on a public address because the friction of inventing a
password to buy in for twenty dollars is what gets an app abandoned. The app's
job there is not to refuse, it is to make the consequence impossible to miss —
on the startup banner, and on the account screen of anyone it affects, loudest
for a poker admin. `REQUIRE_PASSWORDS=1` is the switch for owners who want the
door shut.

**Requirement:** moving between postures must not require editing data. A table
that ran on a laptop has to be able to move to a server, and back, with the same
files. In particular, moving to a public address must never lock an existing
account out of an install it could previously use.

### 3a. Running on a laptop

- One computer at the table hosts it. Usually a laptop.
- Everyone else joins from a phone browser on the same wifi.
- There is no cloud service, no account on anyone else's server, no telemetry.
- Once it is running it must work with the internet unplugged.

**Constraints that follow from that:**

| Constraint | Consequence |
|---|---|
| Runs on a laptop someone owns | Node.js only, no database server to install |
| Must survive no internet | No CDN dependency for anything load-bearing; fonts degrade to system stacks |
| Phones are the main client | Mobile-first, touch targets ≥ 44px, no hover-only affordances |
| The host's laptop may sleep or be restarted | State on disk, sign-ins survive a restart |
| Non-technical host | Double-click to start; no terminal, no config file to edit |
| Browsers gate features on secure contexts | Must serve HTTPS, because `http://192.168.x.x` is not one |

**Requirement:** a first run on a machine with Node installed must reach a usable
app with no steps beyond double-clicking a file.

### 3b. Running on a server

**Requirement:** the app never manages its own certificate behind a proxy, binds
only to loopback so nothing bypasses the proxy, and believes the proxy about the
client's address and scheme — because without that last part every visitor looks
like the proxy, and the rate limiter gives the whole internet one shared budget
of guesses.

**Requirement:** there must be a way back in from a shell. Moving a passwordless
install to a public address would otherwise lock its owner out permanently.

---

## 4. The money model

This is the part that must be right. Everything else is furniture.

### 4.1 Two different numbers

Confusing these is what causes arguments, so they are computed and displayed
separately:

- **Result** — chips cashed out minus chips bought in. "Did I win tonight?"
- **Remaining** — result plus cash that has already changed hands. "Do I still
  owe anyone?"

### 4.2 Invariants

These must hold at all times. Each has a test that fails loudly if it stops
holding.

1. **Results sum to zero across the table.** Chips are conserved; if they are
   not, the app says so by name and amount rather than closing the night.
2. **`Remaining` sums to zero across the table.** This is what makes settlement
   solvable. It only holds if the cash box is treated as a party (see 4.4).
3. **Every ledger entry type the model reads is one something can actually
   create.** No unreachable branches in the money code.
4. **Voiding an entry removes it from every total** without deleting the record
   of it.
5. **Expense shares always add up to the exact amount.** Rounding remainder goes
   to the first person on the list, never dropped.
6. **A closed night's figures cannot be edited.** Reopening is the only route
   back in, and it reverses exactly what closing applied.
7. **Carried debt is replaced, not added to.** A night where nobody wins or
   loses must leave a standing debt exactly where it was.

### 4.3 Buy-ins record how they were paid

Three fundings, because they settle differently:

- **Cash** — money in the box now. Nothing owed.
- **Credit** — chips now, money later. Owed at the end.
- **Covered** — another player put the cash in. The buyer owes *that player*,
  not the table, and settlement must route the repayment back to them.

**Requirement:** the settlement must prefer direct obligations before general
matching, so a fronted buy-in is repaid to the person who fronted it.

### 4.4 The cash box is a party

If more is paid out of the box than went into it — which happens the moment
anyone plays on credit — whoever holds the cash covered the difference from their
own pocket and is owed it back.

**Requirement:** the box's position is folded into the designated banker's line.
Without this the columns do not sum to zero and money ends up belonging to
nobody.

### 4.5 Settlement

**Requirement:** the output is the fewest payments that square everybody, not a
list of every obligation. A five-player night with credit and fronted buy-ins
should resolve in two or three payments.

### 4.6 Money that is not chips

Pizza, drinks, tips, the host's cut. Recorded as cash with three separate facts:
who bears the cost, who ends up with the money, and whose cash actually moved.

**Requirement:** spending never alters chip reconciliation. Chips must still
balance at the end whether or not anyone bought food.

### 4.7 Corrections

**Requirement:** nothing is ever silently overwritten.

- Ledger mistakes are struck out, not deleted; the record stays visible.
- Lifetime stat corrections are stored as deltas with a reason and the admin's
  name; the card shows it was adjusted and the change can be undone.
- A closed night is reopened, fixed, and closed again — never patched from
  outside.

---

## 5. Time

**Requirement:** time at the table is counted per person, and only while the game
is actually running. Someone who arrives for the last hour of a six-hour night
must not be credited with six hours.

Everything derived from time — per-hour figures, the hours badge — is only as
honest as this.

---

## 6. Identity and access

- **A password is optional.** Most of these accounts belong to people sitting in
  the same room as the computer, where "prove it is you" is answered by being
  there. An account without one signs in by having its name tapped.
- Where a password exists it is salted and hashed with scrypt.
- No password or PIN is ever sent to a browser.
- A short PIN may be set as a convenience for the shared laptop at the table. It
  works only on that screen; everything else requires the real password.
- Sign-in tokens are persisted so a restart does not sign the table out. Only a
  hash of each is stored, so a backup cannot be used to walk into an account.
- Guessing is rate limited: strict per account, loose per device.

**Requirement on rate limiting:** the per-device budget must be far looser than
the per-account one. The shared laptop is a shared device by design, and one
person fumbling their own PIN must not lock out the table.

**Requirement:** the last poker admin cannot demote or disable themselves. A site
always has one.

**Requirement:** an account with no password must never be reachable by a route
meant for one that has a password, and the reverse. Tapping a name must be
refused on an account with a password or a PIN; a blank password must be refused
where one is set.

**Consequence, stated plainly:** an account with no password is not protected.
Anyone who can reach the app can sign in as it. That is the intended trade for a
game in someone's house, and it is why the app says so on the account screen and
warns a poker admin who leaves their own account open.

---

## 7. Security posture, stated honestly

The threat model is *your friends on your wifi*, not the open internet. What that
means concretely:

**Protected:** account management, stat corrections, password resets, backups,
anything that changes money, and anything that runs a room. All of it requires
the right role and is enforced server-side.

**Deliberately not protected:** reading a room. Anyone on the network who has a
room code can read its state, ledger, settlement and CSV export without signing
in. The table password gates *joining*, not *looking*. This is a known and
accepted gap, not an oversight — it is written down here so nobody rediscovers it
and assumes it was missed.

If the deployment ever stops being "my friends in my house", that gap is the
first thing to close.

**Also true:** the certificate is self-signed, so browsers warn once per device.
There is no way around that without a real domain name.

---

## 8. Data

- Everything lives in JSON files under `data/`; uploads under `uploads/`.
  Those two folders are the entire database.
- Writes are atomic (write to temp, rename) and flushed on shutdown.
- A half-written file is quarantined rather than crashing the app.
- Backups are one file the poker admin can download; the TLS private key is
  excluded because it is machine-specific and regenerates.

**Requirement:** updating the app must never overwrite `data/`.

---

## 9. Interface

- Mobile first. The room screen must be usable one-handed, in a dim room, by
  someone who has had a drink.
- Two columns on a desktop; the tab bar becomes a side rail.
- Destructive actions confirm, and say what will happen in plain language.
- Errors explain what went wrong and what to do about it. No status codes, no
  jargon, no apologies.
- Reduced motion is respected; focus is always visible.
- No horizontal scrolling at 390px.

**Requirement:** any action that moves or erases money either confirms first or
offers an undo.

---

## 10. Browsers

**Requirement:** the app works on Safari on an iPhone, Safari on a Mac, Firefox
on any platform, and anything Chromium. "Works" means every screen renders and
every action completes — not that every nicety is available.

The floor is Safari 15.4 and Firefox 91. Below that, say so; do not degrade
silently.

**Requirement:** a missing capability degrades, never throws. An engine that has
no vibration, no wake lock, no app badge, no Web Share and no notifications at
all must still run a whole night without a single error in the console.

This is not hypothetical. A single `Notification?.permission` at module scope
took the app down to a blank page on every iPhone, because optional chaining
forgives a null value but not an identifier that was never declared. The rule
that follows: **reach a global that some target browser lacks only through
`typeof`**, never through a property access, however defensive the syntax looks.

**Requirement:** where a capability cannot be offered, the interface says why
rather than showing a control that does nothing.

**Requirement:** no single test angle is trusted to cover this. Running one
engine misses what another leaves out; running the source through an analyser
misses what only happens live. Three suites, deliberately overlapping:
API-stripping, a real WebKit, and static analysis against a support matrix.

## 11. Phones

**Requirement:** the interface is designed for a phone held one-handed, in a dim
room, by someone who has had a drink.

- Nothing scrolls sideways at any width from 360px up.
- Every control a finger is meant to hit is at least 44px tall on a coarse
  pointer. Compact sizes are for a mouse.
- Content clears the notch and the home indicator: `viewport-fit=cover`, and
  every `env(safe-area-inset-*)` carries a fallback.
- The tab bar grows by the bottom inset rather than sitting under the home
  indicator, and the page reserves room for it so nothing is trapped behind.
- Sheets keep their buttons above the home indicator.

**Requirement:** anything hidden is `display: none`, not merely transparent or
moved offscreen, so it is gone for a screen reader and untabbable too.

## 12. Quality bar

Nine suites, run against the code that actually ships:

| Suite | Covers | Needs |
|---|---|---|
| `test-ledger` | The money model in isolation | nothing |
| `test-api` | Every endpoint, roles, the full night | nothing |
| `test-compat` | The source against each browser's support | nothing |
| `test-ui` | The real interface in a real browser | puppeteer |
| `test-layout` | Geometry and visibility on eight phones | puppeteer |
| `test-degraded` | Engines missing APIs: iOS Safari, Firefox | puppeteer |
| `test-webkit` | A genuine WebKit build | webkit2gtk-driver |
| `test-secure` | That a phone on the wifi gets a secure context | puppeteer |
| `test-hosted` | That a public address closes what it claims to | nothing |

**Requirements:**

- `npm test` runs with no dependencies beyond the app's own.
- The money invariants in 4.2 each have a test that asserts them directly.
- Every suite must be shown to fail when the bug it guards against is put back.
  A regression test that cannot fail is decoration.
- The packaged build is a byte-identical copy of source. No patching at package
  time, because then what ships is not what was tested.
- A suite skips politely when its tooling is absent, rather than failing.
- **No suite may write to the install it is run from.** Storage paths are
  overridable and the tests point at a throwaway directory. One of them deletes
  its data folder when it finishes, and on a server that folder is a season of
  poker history.
- Running a suite twice in a row gives the same result both times.

## 11. Out of scope

Stated so they are not mistaken for gaps:

- Dealing cards, hand histories, hole cards, or anything that knows poker rules.
- Blind timers and tournament clocks. Blinds are moved by people at the table.
- Counting chips. Stacks are made in dollar increments and the total is typed in.
- Real-money transfer. Payment links open someone else's app.
- Anything that requires an account on a server this group does not own.
