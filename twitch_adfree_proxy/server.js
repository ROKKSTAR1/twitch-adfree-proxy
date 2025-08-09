// server.js — Node 18+ (ESM). Works on Render free tier.
// Env vars expected (Render → Environment):
//   TWITCH_CLIENT_ID        = your client id
//   (TWITCH_CLIENT_SECRET   = optional; not required here)

import express from "express";

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const USHER = "https://usher.ttvnw.net/api/channel/hls";
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || "kimne78kx3ncx6brgo4mv6wki5h1ko";

const app = express();

// ---- CORS (so iPhone Safari can fetch from your domain)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => res.type("text").send("ok"));

// ---- Ask Twitch for a playback token/signature using a full GQL query
async function getPlaybackToken(login) {
  const query = `
    query PlaybackAccessToken(
      $login: String!,
      $isLive: Boolean!,
      $vodID: ID!,
      $isVod: Boolean!,
      $playerType: String!
    ) {
      streamPlaybackAccessToken(
        channelName: $login,
        params: { platform: "web", playerBackend: "mediaplayer", playerType: $playerType }
      ) @include(if: $isLive) {
        value
        signature
        __typename
      }
      videoPlaybackAccessToken(
        id: $vodID,
        params: { platform: "web", playerBackend: "mediaplayer", playerType: $playerType }
      ) @include(if: $isVod) {
        value
        signature
        __typename
      }
    }
  `;

  const body = [{
    operationName: "PlaybackAccessToken",
    variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site" },
    query
  }];

  const headers = {
    "Client-ID": CLIENT_ID,
    "GQL-Client-Id": CLIENT_ID,
    "Content-Type": "application/json",
    "Origin": "https://www.twitch.tv",
    "Referer": "https://www.twitch.tv/"
  };

  const r = await fetch(TWITCH_GQL, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("gql_failed_" + r.status);

  const j = await r.json();
  const liveTok = j?.[0]?.data?.streamPlaybackAccessToken;
  const vodTok  = j?.[0]?.data?.videoPlaybackAccessToken;
  const tok = liveTok || vodTok;
  if (!tok?.signature || !tok?.value) throw new Error("no_token");
  return tok;
}

// ---- Return a cleaned master playlist for a channel
app.get("/playlist/:channel", async (req, res) => {
  try {
    const login = String(req.params.channel || "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return res.status(400).type("text").send("bad_channel");

    // A) token + signature via GQL
    const tok = await getPlaybackToken(login);

    // B) fetch Usher master m3u8
    const url = new URL(`${USHER}/${encodeURIComponent(login)}.m3u8`);
    url.searchParams.set("sig", tok.signature);
    url.searchParams.set("token", tok.value);
    url.searchParams.set("allow_source", "true");
    url.searchParams.set("allow_audio_only", "true");
    url.searchParams.set("player", "twitchweb");
    url.searchParams.set("p", String(Math.floor(Math.random() * 1e7)));
    url.searchParams.set("client_id", CLIENT_ID);

    const up = await fetch(url, { headers: { "Client-ID": CLIENT_ID } });
    if (!up.ok) throw new Error("usher_failed_" + up.status);

    // Raw master playlist text
    let text = await up.text();

    // C) Remove ad dateranges if present
    text = text
      .split("\n")
      .filter(line => {
        if (line.startsWith("#EXT-X-DATERANGE")) {
          const l = line.toLowerCase();
          if (l.includes("stitched-ad") || l.includes("twitchad")) return false;
        }
        return true;
      })
      .join("\n");

    // D) Proxy any absolute URLs so the browser can fetch with CORS
    const host = `${req.protocol}://${req.get("host")}`;
    const proxied = text.replace(/https?:\/\/[^\s]+/g, u => `${host}/segment?u=${encodeURIComponent(u)}`);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(proxied);
  } catch (e) {
    console.error("playlist_error:", e?.message || e);
    res.status(500).type("text").send(e?.message || "error");
  }
});

// ---- Proxy nested playlists and media segments (and rewrite inside child playlists)
app.get("/segment", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).type("text").send("missing_u");

    const upstream = await fetch(u);
    if (!upstream.ok) throw new Error("upstream_" + upstream.status);

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");

    if (ct.includes("application/vnd.apple.mpegurl")) {
      let text = await upstream.text();

      // remove ad dateranges again for child playlists
      text = text
        .split("\n")
        .filter(line => {
          if (line.startsWith("#EXT-X-DATERANGE")) {
            const l = line.toLowerCase();
            if (l.includes("stitched-ad") || l.includes("twitchad")) return false;
          }
          return true;
        })
        .join("\n");

      // rewrite relative & absolute URLs through our proxy
      const base = new URL(u);
      const host = `${req.protocol}://${req.get("host")}`;
      text = text.replace(/^(?!#).*$/gm, line => {
        const s = line.trim();
        if (!s || s.startsWith("#")) return s;
        let abs;
        try { abs = new URL(s, base).toString(); } catch { abs = s; }
        return `${host}/segment?u=${encodeURIComponent(abs)}`;
      });

      return res.send(text);
    }

    // binary segment (TS, CMAF)
    const buf = await upstream.arrayBuffer();
    return res.end(Buffer.from(buf));
  } catch (e) {
    console.error("segment_error:", e?.message || e);
    res.status(500).type("text").send(e?.message || "error");
  }
});

// ---- Static files (e.g., public/twitchhub_proxy.html)
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server on :" + PORT));
