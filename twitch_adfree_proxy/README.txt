# Twitch Ad-Filter Proxy (Educational Demo)

This mini project sets up a small Node.js server that:
- Fetches a Twitch HLS playlist for a channel
- Removes common ad markers (EXT-X-DATERANGE with "stitched-ad"/"TwitchAd")
- Proxies all playlists/segments with CORS enabled so an iPhone browser can play them
- Serves a simple front-end at `/twitchhub_proxy.html` using hls.js

> ⚠️ Twitch can change internals anytime. This is for educational purposes. Using it may violate Twitch ToS.


## Quick Start on Glitch (easiest, free)

1) Go to https://glitch.com → **New Project** → **Hello-Express**.
2) In Glitch:
   - Replace `package.json` with the one from this ZIP.
   - Replace `server.js` with the one from this ZIP.
   - In the left sidebar, create folder `public/` if it doesn't exist.
   - Add file `public/twitchhub_proxy.html` and paste the content from this ZIP.
3) Click **Tools → Logs** to watch it start. It auto-installs dependencies.
4) Click **Preview → In a new window** to open the live URL.
5) Open `/twitchhub_proxy.html`, type a channel, press **Play**.

(Optional) Set an environment variable `TWITCH_CLIENT_ID` in Glitch **.env** to your own Client ID (from https://dev.twitch.tv/console/apps).


## Using with your existing "twitchhub_pro.html"

- Keep your original page for **Followed** & **Explore** (login needed).
- Add a new button "Play via Proxy" that opens `/twitchhub_proxy.html?channel=...` on your Glitch domain.
- Or embed the proxy video tag into your page using hls.js, replacing the Twitch embed only when you prefer ad-free.


## Notes
- 100% blocking is not guaranteed; Twitch may still switch to fully server-side segments. This proxy strips common ad markers and proxies all content to avoid CORS.
- For chat, embed: `https://www.twitch.tv/embed/CHANNEL/chat?parent=YOURDOMAIN`


## Run locally (optional)
```bash
npm install
npm start
# open http://localhost:3000/twitchhub_proxy.html
```
