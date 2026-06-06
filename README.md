# YTScan 🎯

**Find promo codes buried in YouTube videos — without watching the full thing.**

YTScan is a locally-hosted web app. You paste a YouTube video URL (or add a channel), it scans the transcript, and pulls out every discount code, sponsor offer, and limited-time deal — with the exact timestamp so you can jump straight to it.

## Why it works locally

YouTube blocks transcript requests from cloud servers. Running this on your own machine means it uses your home IP, so transcripts fetch reliably without any API keys.

## Features (MVP)

- **Scan a single video** — paste any YouTube URL, get all deals in seconds
- **Watch a channel** — add a channel URL and YTScan scans its latest videos automatically
- **Scan all channels** — one click to refresh everything
- **Jump to timestamp** — every deal shows exactly when it was mentioned
- **Copy promo code** — one click copy

## Tech stack

- **Backend:** Bun + Hono (TypeScript)
- **Frontend:** Vanilla HTML/CSS/JS (zero dependencies, zero build step)
- **Transcript:** `youtube-transcript-api` via Python subprocess
- **Data:** JSON file (no database needed for MVP)

## Setup

### 1. Install dependencies

```bash
# Node/Bun
bun install

# Python transcript library
pip install youtube-transcript-api
```

### 2. Run locally

```bash
bun src/server.ts
```

Open `http://localhost:4242` in your browser.

## Usage

### Scan a single video
1. Paste any YouTube video URL into the **Scan a Video** box
2. Click **Scan for deals**
3. See all promo codes and deals with timestamps

### Watch a channel
1. Paste a YouTube channel URL (e.g. `https://www.youtube.com/@mkbhd`)
2. Click **Add Channel** — YTScan scans the latest 5 videos immediately
3. Click **Scan All Channels** anytime to refresh

## Next iteration

- [ ] Auto-scan on a schedule (every 2 hours)
- [ ] Browser notifications when a new deal is found
- [ ] Filter by category (tech, fashion, fitness, finance)
- [ ] Affiliate link detection
- [ ] Export deals to CSV
- [ ] Chrome extension companion
