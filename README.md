# element-call

A customizable fork of [element-hq/element-call](https://github.com/element-hq/element-call)
on the `livekit` (MatrixRTC + LiveKit) branch.

Licensed under [AGPL-3.0](LICENSE-AGPL-3.0). The upstream commercial
license offer at `LICENSE-COMMERCIAL` belongs to Element / New Vector
Ltd. and applies to upstream code only.

## What this fork adds

- **Configurable branding** — product name, logo, footer, privacy policy
  link, source-code link, scheduled-meeting state event type, and bot
  user prefix all live in `config.json` under a `branding` key.
  Source ships with neutral defaults; deployments override at runtime.
- **Room codes** — short alphanumeric codes per room, derived into the
  per-room E2EE shared key via PBKDF2 over the canonical alias. Codes
  rotate, can be revealed/copied in-call, and can be entered on the
  home page to join.
- **Knock-based access** — rooms default to knock; hosts get an
  approve / reject panel with notification sound.
- **Guest registration proxy** — a separate Node service that holds
  the homeserver's registration shared secret server-side, so the
  client doesn't need to walk the UIA flow for guests.
- **Scheduled meetings** — frontend reads booking metadata from a
  configurable Matrix state event type and lists upcoming meetings on
  the home page with a mini-calendar view.
- **Admin API service** — a separate Node service for booking-driven
  room lifecycle (create / update / close / reopen / delete), with
  PBKDF2 key material baked into room state at creation.
- **AGPL license footer** — discoverable Source link in the footer and
  in a License tab in Settings.

For everything else — architecture, build, dev-server setup, widget
mode, testing — see [the upstream README](https://github.com/element-hq/element-call/blob/livekit/README.md).

## Configuring the branding

Add a `branding` block to `config.json`:

```json
{
  "branding": {
    "product_name": "Your Product",
    "logo_url": "https://example.com/logo.svg",
    "website_url": "https://example.com",
    "privacy_policy_url": "https://example.com/privacy",
    "footer_text": "Your Org",
    "footer_url": "https://example.com",
    "source_code_url": "https://github.com/your/repo",
    "meeting_event_type": "io.example.scheduled_meeting",
    "bot_user_prefix": "your-bot"
  }
}
```

Every field is optional. Unset fields fall back to neutral defaults
(upstream Element Call branding, AGPL-only footer text, the Element
Call upstream repo as the Source link, and a generic
`io.element.call.scheduled_meeting` event namespace).

`product_name` can also be set at build time via `VITE_PRODUCT_NAME`,
which is what the page `<title>` reads.

## Services

`services/admin-api/` and `services/registration-proxy/` are
independent Node 20 HTTP services. They are AGPL-licensed (this
repository's license applies) but share no imports with the frontend,
so they can be deployed alongside or replaced freely. See the
`Dockerfile` in each directory.

## Scheduling and calendar services

`services/admin-api/` creates one Matrix room per booking and writes the
meeting to a CalDAV collection. `services/meeting-worker/` sends the
reminder and reschedule mail and enforces data retention. Both are
configured entirely by environment variable, so pointing them at your own
homeserver, calendar server and mailbox needs no source change.

Calendar writes are best-effort throughout: a calendar or mail failure is
logged and never fails the room operation.

### Room service (`services/admin-api/`)

| Variable                                  | Default                             | Purpose                                                                                               |
| ----------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SYNAPSE_URL`                             | `http://localhost:8008`             | Homeserver base URL                                                                                   |
| `BOT_ACCESS_TOKEN`                        | required                            | Access token of the account that creates rooms                                                        |
| `SERVER_NAME`                             | required                            | Matrix server name, e.g. `example.com`                                                                |
| `ELEMENT_CALL_BASE_URL`                   | required                            | Public base URL of this app, used to build join links                                                 |
| `ADMIN_API_KEY`                           | required                            | Static key for service-to-service calls. Never ship it to a browser                                   |
| `PORT`                                    | `6091`                              | Listen port                                                                                           |
| `SCHEDULERS_ROOM_ID`                      | unset                               | Room whose joined members may schedule with their own Matrix token. Unset accepts only the static key |
| `ALLOWED_ORIGINS`                         | unset                               | Comma-separated origins allowed to call the API from a browser                                        |
| `MEETING_STATE_TYPE`                      | `io.element.call.scheduled_meeting` | State event type holding the booking                                                                  |
| `ROOM_ALIAS_PREFIX`                       | `meet-`                             | Alias localpart prefix, visible in every join link. New rooms only                                    |
| `DEFAULT_TIMEZONE`                        | `UTC`                               | IANA zone recorded when a request omits one                                                           |
| `REMINDER_DEFAULT_MINUTES`                | `30`                                | Reminder lead time when a request omits one; `0` disables it                                          |
| `BOT_USER_PREFIX`                         | `call-bot`                          | Localpart of the room-creating account                                                                |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `30`                      | Per-address request limit                                                                             |

### Calendar (both services)

Leave `CALDAV_URL_BASE`, `CALDAV_USER` or `CALDAV_PASSWORD` unset and no
calendar is written at all; rooms, join links and mail still work.

| Variable                       | Default                                | Purpose                                                                                                                                            |
| ------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CALDAV_URL_BASE`              | unset                                  | Collection URL, e.g. `https://caldav.example.com/dav/calendar@example.com/Calendar/personal`                                                       |
| `CALDAV_USER`                  | unset                                  | Account that owns the collection, e.g. `calendar@example.com`                                                                                      |
| `CALDAV_PASSWORD`              | unset                                  | Its password. Never logged                                                                                                                         |
| `CALDAV_ORGANIZER_EMAIL`       | `CALDAV_USER` when that is an address  | Address written as the event organizer. It must be an address of the account owning the collection, or the server will not schedule on your behalf |
| `CALDAV_ORGANIZER_NAME`        | unset                                  | Display name beside the organizer address                                                                                                          |
| `MEETING_SUMMARY_TEMPLATE`     | `Appointment`                          | Event title, which is also the subject of every invitation mail                                                                                    |
| `MEETING_DESCRIPTION_TEMPLATE` | `Join the appointment:\n{{meet_link}}` | Event body text                                                                                                                                    |
| `ICS_ALARM_MINUTES`            | unset                                  | Minutes before the start for a display alarm. Unset or `0` writes none                                                                             |

Both templates accept `{{prospect_name}}`, `{{organizer_name}}` and
`{{meet_link}}`; an unknown placeholder renders empty. The title reaches
notification previews on every device the collection is subscribed from,
so it names nobody unless you ask it to.

On a calendar server that implements RFC 6638 scheduling, writing the
event is also what invites the attendees, and an attendee with an account
on that server gets the meeting in their own calendar without doing
anything. The room service checks for that capability once at startup and
says in its log whether the server advertises it. See
[Calendar client setup](./docs/calendar-clients.md).

### Mail and retention (`services/meeting-worker/`)

| Variable                      | Default | Purpose                                                                                                                                                |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SMTP_HOST`                   | unset   | Mail server host                                                                                                                                       |
| `SMTP_PORT`                   | `587`   | Mail server port                                                                                                                                       |
| `SMTP_SECURE`                 | off     | Set to `1` for implicit TLS on port 465, otherwise STARTTLS                                                                                            |
| `SMTP_USER` / `SMTP_PASSWORD` | unset   | Credentials. Omit both for an unauthenticated relay                                                                                                    |
| `SMTP_FROM`                   | unset   | Envelope sender, e.g. `calendar@example.com`                                                                                                           |
| `REMINDER_LANG`               | `en`    | Language of reminder and reschedule mail: `en`, `nl` or `de`                                                                                           |
| `POLL_INTERVAL_MS`            | `60000` | How often the mail pass runs                                                                                                                           |
| `MEETING_RETENTION_DAYS`      | `30`    | Days after a meeting ends before names, addresses and the join link are erased from room state and the calendar event is removed                       |
| `MEETING_DRY_RUN`             | off     | Set to `1` to log what the reschedule notice and the retention purge would do without doing it. Reminder mail is not covered by this and is still sent |

Reminder and reschedule mail is sent as HTML with a plain-text alternative.
These control how it looks; all are optional, and an unset one is simply not
rendered.

| Variable              | Default   | Purpose                                                      |
| --------------------- | --------- | ------------------------------------------------------------ |
| `MAIL_BRAND_NAME`     | unset     | Name shown in the header, and the logo's alt text            |
| `MAIL_BRAND_LOGO_URL` | unset     | `https://` image used in the header instead of the name      |
| `MAIL_BRAND_COLOR`    | `#2c7a7b` | Hex accent for the join button and links                     |
| `MAIL_FOOTER_TEXT`    | unset     | One line below a rule, for an address or an unsubscribe note |

`SYNAPSE_URL`, `BOT_ACCESS_TOKEN`, `SERVER_NAME`, `MEETING_STATE_TYPE`,
`REMINDER_DEFAULT_MINUTES`, `DEFAULT_TIMEZONE` and the calendar variables
above have the same meaning here as in the room service.

### Running the service tests

```sh
yarn test:services
```

Node's own test runner over `services/**/*.test.mjs`. No network, no
homeserver and no calendar server: every outbound call is stubbed.

## Configuring the calendar

Signed-in users get a calendar at `/calendar` with week, month, day and
agenda views, and a compact month grid on the home page. It reads
meetings straight out of the rooms the client has already synced, so it
works offline and updates as changes arrive.

Add a `calendar` block to `config.json` to change what the scheduling
form offers and how the grids are laid out:

```json
{
  "calendar": {
    "default_timezone": "UTC",
    "duration_options": [15, 30, 45, 60],
    "default_duration_minutes": 30,
    "reminder_options": [15, 30, 60, 120],
    "default_reminder_minutes": 30,
    "first_day_of_week": "auto",
    "day_start_hour": 8,
    "day_end_hour": 18
  }
}
```

| Key                               | Default             | Purpose                                                                                                                |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `default_timezone`                | `UTC`               | IANA zone recorded with a meeting when the browser reports none of its own                                             |
| `duration_options`                | `[15, 30, 45, 60]`  | Meeting lengths offered, in minutes. The shortest is also the granularity of clicking an empty slot                    |
| `default_duration_minutes`        | `30`                | Length preselected in the form                                                                                         |
| `reminder_options`                | `[15, 30, 60, 120]` | Reminder lead times offered, in minutes                                                                                |
| `default_reminder_minutes`        | `30`                | Lead time preselected in the form                                                                                      |
| `first_day_of_week`               | `auto`              | `auto` follows the reader's locale; otherwise name a day, e.g. `sunday`                                                |
| `day_start_hour` / `day_end_hour` | `8` / `18`          | Working hours the time grid highlights and opens on. It still renders the whole day, so nothing outside them is hidden |

Every field is optional, and so is the block. Dates, times, month and
weekday names are formatted from the language the interface is running
in, not from translations, so a new language needs no calendar strings
beyond the labels.

Two other options govern who may schedule at all: `admin_api_url` points
at the room service, and `schedulers_room_id` names the room whose joined
members may create, move and cancel meetings. Without both, the calendar
is read-only and the scheduling form is hidden.

## License & source availability

This is AGPL-3.0 software. If you serve a modified version to users,
you must offer them the corresponding source. The Source link in the
in-app license footer is driven by `branding.source_code_url`; set it
to your public fork before deploying.

Upstream Element Call copyright and license headers are preserved on
the files we did not author. New files we added carry no copyright
header and are licensed under AGPL-3.0 by virtue of being part of this
combined work.
