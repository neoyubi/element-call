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

## License & source availability

This is AGPL-3.0 software. If you serve a modified version to users,
you must offer them the corresponding source. The Source link in the
in-app license footer is driven by `branding.source_code_url`; set it
to your public fork before deploying.

Upstream Element Call copyright and license headers are preserved on
the files we did not author. New files we added carry no copyright
header and are licensed under AGPL-3.0 by virtue of being part of this
combined work.
