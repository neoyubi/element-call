# Calendar client setup

How a scheduled meeting reaches a calendar, and how to see the whole
schedule in your own client.

Every address and URL below is a placeholder. Substitute your own
deployment's values; your administrator can tell you what they are.

## Two ways a meeting arrives

A meeting is written once, to a single shared calendar collection owned
by a scheduling account — `calendar@example.com` in the examples here.
From there it reaches people in two different ways, and it is worth
understanding which one you are relying on.

**Automatically, into your own calendar.** If your calendar server
implements RFC 6638 scheduling and you have an account on it, the server
delivers the meeting into a calendar you own the moment it is written.
You do nothing at all: it simply appears, updates when the meeting is
moved, and disappears when it is cancelled.

**By invitation mail.** For anyone without an account on that server —
an external attendee, or a colleague whose calendar lives elsewhere — the
server sends an ordinary iMIP invitation by email. Whether that invitation
is added to their calendar automatically is entirely their own client's
policy, and many clients require the recipient to accept it first, or
filter an unsolicited calendar attachment out altogether.

A meeting always carries a join link in plain text in the reminder and
reschedule mail this application sends, so nobody depends on the calendar
for the link itself.

## When a meeting does not appear automatically

Three things have to hold, and they fail quietly.

**The server has to advertise scheduling support.** The room service
checks this once at startup and prints the result, so ask an
administrator to look for the line about automatic scheduling in the
service log. You can also check it yourself if you can reach the server:

```sh
curl -s -I -X OPTIONS -u 'calendar@example.com' \
  https://caldav.example.com/dav/calendar@example.com/Calendar/personal
```

Look for `calendar-auto-schedule` in the `DAV:` response header. If it is
missing, the server will not deliver anything into anyone's calendar and
everyone is on the invitation-mail path.

**The address on the meeting has to be one the server recognises as
yours.** The meeting carries the address recorded for you when it was
booked. If that is a typo, an alias the server does not resolve, or an
address at a different provider, the server treats you as an external
attendee and mails you instead. Aliases are the usual culprit: many
servers match only the exact addresses attached to your account, not
every address that eventually reaches your mailbox.

**Your client has to be syncing the calendar the server wrote into.**
Servers deliver into the account's default or personal calendar. If you
have several calendars and your client only syncs some of them, the
meeting is there but you are not looking at it.

## Subscribing to the shared collection

The automatic path gives you your own meetings. It cannot show you anyone
else's, because nothing was ever delivered to you for those. To see the
whole schedule — for a reception desk, or to cover for a colleague — you
subscribe to the shared collection directly.

> **This exposes every meeting in the collection.** Everyone who is
> subscribed sees every attendee's name, and the join link, for every
> booking, on every device where that calendar is configured. A join link
> is enough on its own to enter a meeting. Treat a subscription as a
> deliberate decision about who may see the whole schedule, not as a
> default for all staff.

**Subscribe read-only.** Grant a subscriber a view-only right on the
collection, never a right to create or modify. This is not only about
data: the room service is the authoritative writer and replaces the whole
event whenever a meeting changes, so an edit made in a subscribed client
is silently discarded on the next change. A read-only grant means that
conflict cannot arise. Every CalDAV server has some form of per-collection
access control; the exact name of the view-only right differs between
implementations, so consult your server's documentation.

### Finding the collection URL

The URL has the shape

```
https://caldav.example.com/dav/calendar@example.com/Calendar/personal
```

and it is the same value the room service is configured with, so an
administrator can read it straight off. To find it yourself, sign in to
the calendar server's own web interface and look for the collection's
properties or a "link"/"subscribe"/"share" action; servers generally show
the CalDAV URL there. Most clients will also accept the account's base
DAV URL and discover the collection for you.

### In a groupware web interface (for example SOGo)

A shared collection appears in the calendar list once the owning account
has granted you access — there is nothing to configure. If it does not
appear, the grant has not been made, or has been made to a different
address than the one you sign in with.

### In Thunderbird

Create a new calendar, choose the network/CalDAV option, and give it
either the collection URL above or the account's base DAV URL and let it
discover what is available. Authenticate as yourself, not as the
scheduling account.

Two things to expect. Updates arrive on a poll, not instantly: the
refresh interval is a per-calendar setting and defaults to tens of
minutes. And when an invitation has already been added to your calendar
by the server, the invitation bar on the mail may say there is nothing to
do — that is correct, not a failure.

### In Apple Calendar (macOS and iOS)

Add a CalDAV account in the system account settings, using either the
server hostname or the full collection URL, and authenticate as yourself.
The shared collection then appears alongside your own.

The address the meeting was booked with must be one your account owns.
Apple's clients match the exact address, so an alias that merely forwards
to you is not enough.

### In Outlook over Exchange ActiveSync

Outlook does not speak CalDAV. It reaches the calendar through an
ActiveSync gateway, if your server offers one, by adding the account as an
Exchange or ActiveSync account.

ActiveSync's model is one default calendar per account. Whether a second,
shared collection is synchronised at all depends on the gateway, and on
older Outlook versions may not be possible; check what your server's
ActiveSync support offers before promising it to anyone.

## What this application deliberately does not do

**It never reports whether the calendar write succeeded.** Calendar
writes are best-effort by design and no room operation fails because of
one. Nothing in the interface claims a meeting is "synced", because there
would be no truthful way to know.

**It never reads a reply back.** Accepting or declining in your own client
is a message to the calendar server; nothing in this application reads it,
and no screen shows who has accepted. Expect, too, that an edit to a
meeting resets your acceptance and asks you again, because a changed
meeting is a new invitation as far as your client is concerned.

**Cancelling removes the event; it does not send a separate message from
here.** When a meeting is cancelled, the calendar resource is deleted, and
it is the calendar server that notifies the attendees.
