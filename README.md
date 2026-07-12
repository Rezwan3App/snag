# Snag 🎯

**Find the promo codes and deals buried in YouTube videos, without watching the full thing.**

🔗 **Live demo:** [snag-2232.onrender.com](https://snag-2232.onrender.com) *(free tier, first load may take ~30s to wake up)*

Creators drop discount codes in sponsor reads and video descriptions. Then the video scrolls out of your feed and the code is gone. Snag watches the channels you follow, scans every new upload's description, and pulls out the codes, sponsor links, and expiry dates. Add your phone number and it texts them to you.

## How it works

1. Search for a YouTuber and add their channel to your watchlist.
2. Snag reads the channel's RSS feed (no YouTube API key needed) and runs each video description through a set of promo-detection rules: `use code X`, `20% off`, free trials, giveaways, limited-time offers.
3. Detected deals are saved with their code, sponsor link, and expiry date, and shown in the dashboard.
4. New deals are texted to you via Twilio. Without Twilio credentials, Snag runs in demo mode and logs the message it would have sent.
5. A background job re-scans every watched channel on an interval, so new uploads get caught automatically.

## Running it locally

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev
```

Open http://localhost:4242.

Run the test suite with:

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
| `TWILIO_AUTH_TOKEN` | Twilio auth token | demo mode |
| `TWILIO_FROM_NUMBER` | Sending phone number | demo mode |

## Stack

- [Bun](https://bun.sh) runtime with a [Hono](https://hono.dev) server
- Vanilla HTML/CSS/JS frontend in `public/`
- JSON file storage (`ytscan.json`, created at runtime and gitignored)
- YouTube channel RSS feeds for video data, YouTube search scraping for channel lookup

## Deploying your own

Snag is a server app (it scans in the background and sends texts), so it needs a host that runs a process. Render, Railway, or Fly.io free tiers all work; static hosts like GitHub Pages can't run it.

A [render.yaml](render.yaml) blueprint is included. On Render:

1. Create an account at [render.com](https://render.com) and connect your GitHub.
2. Click **New → Blueprint**, pick this repo, and deploy.
3. (Optional) Add the three Twilio environment variables to send real texts.

Free-tier notes: the service sleeps after 15 minutes of inactivity (background scans pause while asleep), and the JSON data file resets on restarts since free instances have no persistent disk. Fine for a demo; for always-on alerts use a paid instance or swap in a hosted database.
