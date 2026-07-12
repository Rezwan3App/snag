# Snag

Find the promo codes and deals buried in YouTube videos, without watching the full thing.

Creators drop discount codes in sponsor reads and video descriptions, then the video scrolls out of your feed and the code is gone. Snag watches the channels you follow, scans every new upload's description, and pulls out the codes, sponsor links, and expiry dates. If you add your phone number, it texts them to you.

## How it works

1. Search for a YouTuber and add their channel to your watchlist.
2. Snag reads the channel's RSS feed (no YouTube API key needed) and runs each video description through a set of promo-detection rules: `use code X`, `20% off`, free trials, giveaways, limited-time offers.
3. Detected deals are saved with their code, sponsor link, and expiry date, and shown in the dashboard.
4. New deals are texted to you via Twilio. Without Twilio credentials, Snag runs in demo mode and logs the message it would have sent.
5. A background job re-scans every watched channel on an interval, so new uploads get caught automatically.

## Running it

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev
```

Open http://localhost:4242.

## Tests

```sh
bun test
```

## Configuration

All optional, via environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `4242` |
| `SCAN_INTERVAL_MINUTES` | How often watched channels are re-scanned | `30` |
| `TWILIO_ACCOUNT_SID` | Twilio credentials for real SMS | demo mode |
| `TWILIO_AUTH_TOKEN` | | demo mode |
| `TWILIO_FROM_NUMBER` | Sending phone number | demo mode |

## Stack

- [Bun](https://bun.sh) runtime, [Hono](https://hono.dev) server
- Vanilla HTML/CSS/JS frontend in `public/`
- JSON file storage (`ytscan.json`, created at runtime and gitignored)
- YouTube channel RSS feeds for video data, YouTube search scraping for channel lookup

## Deploying

Snag is a server app (it scans in the background and sends texts), so it needs a host that runs a process — Render, Railway, or Fly.io free tiers all work. Static hosts like GitHub Pages can't run it. On Render: create a Web Service from this repo, set the build command to `bun install` and the start command to `bun run start`.
