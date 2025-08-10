// server.js — Node 18+ (ESM). Works on Render free tier.
// Required env vars in Render → Environment:
//   TWITCH_CLIENT_ID
//   TWITCH_CLIENT_SECRET

import express from "express";
import crypto from "crypto";

const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_INTEGRITY = "https://gql.twitch.tv/integrity";
const USHER = "https://usher.ttvnw.net/api/channel/hls";

const CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn("⚠️ Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET");
}

const app = express();

// ----- CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => res.type("text").send("ok"));

// ----- Simple in-memory caches
let appToken = null;
let appTokenExp = 0;

let integrityToken = null;
let integrityExp = 0;

// Stable per-process device id
const DEVICE_ID = crypto.randomUUID();

// Get OAuth app token
async function getAppToken() {
  const now = Math.floor(Date.now() / 1000);
  if (appToken && now < appTokenExp - 60) return appToken;

  const url =
    `https://id.twitch.tv/oauth2/token` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(CLIENT_SECRET)}` +
    `&grant_type=client_credentials`;

  const r = await fetch(url, { method: "POST" });
  if (!r.ok) throw new Error("oauth_failed_" + r.status);
  const j = await r.json();
  appToken = j.access_token;
  appTokenExp = now + (j.expires_in || 3600);
  return appToken;
}

// Get Client-Integrity token (required by GQL in many regions)
async function getIntegrityToken() {
  const now = Math.floor(Date.now() / 1000);
  if (integrityToken && now < integrityExp - 60) return integrityToken;

  const bearer = await getAppToken();
  const r = await fetch(TWITCH_INTEGRITY, {
    method: "POST",
    headers: {
      "Client-ID": CLIENT_ID,
      "Authorization": `Bearer ${bearer}`,
      "X-Device-Id": DEVICE_ID,
      "Content-Type": "application/json",
      "Origin": "https://www.twitch.tv",
      "Referer": "https://www.twitch.tv/"
    },
    body: "{}"
  });

  if (!r.ok) throw new Error("integrity_failed_" + r.status);
  const j = await r.json();
  // response has: token, expiration
  integrityToken = j.token;
  // if expiration provided (seconds), honor it; else 10 minutes
  integrityExp = now + (j.expiration || 600);
  return integrityToken;
}

// Ask Twitch for a playback token/signature via full GQL + Bearer + Integrity + Device
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
      ) @include(if: $isLive) { value signature __typename }
      videoPlaybackAccessToken(
        id: $vodID,
        params: { platform: "web", playerBackend: "mediaplayer", playerType: $playerType }
      ) @include(if: $isVod) { value signature __typename }
    }
  `;

  const body = [{
    operationName: "PlaybackAccessToken",
    variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site" },
    query
  }];

  const bearer = await getAppToken();
  const integrity = await getIntegrityToken();

  const headers = {
    "Client-ID": CLIENT_ID,
    "GQL-Client-Id": CLIENT_ID,
    "Authorization": `Bearer ${bearer}`,
    "Client-Integrity": integrity,
    "X-Device-Id": DEVICE_ID,
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

// Return a cleaned master playlist
app.get("/playlist/:channel", async (req, res) => {
  try {
    const login = String(req.params.channel || "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return res.status(400).type("text").send("bad_channel");

    const tok = await getPlaybackToken(login);

    const url = new URL(`${USHER}/${encodeURIComponent(login)}.m3u8`);
    url.searchParams.set("sig", tok.signature);
    url.searchParams.set("token", tok.value);
    url.searchParams.set("allow_source", "true");
    url.searchParams.set("allow_audio_only", "true");
    url.searchParams.set("player", "twitchweb");
    url.searchParams.set("p", String(Math.floor(Math.random() * 1e7)));
    url.searchParams.set("client_id", CLIENT_ID);

    const up = await fetch(url, { headers: { "Client-ID": CLIENT_ID, "X-Device-Id": DEVICE_ID } });
    if (!up.ok) throw new Error("usher_failed_" + up.status);

    let text = await up.text();

    // strip common ad dateranges
    text = text.split("\n").filter(line => {
      if (line.startsWith("#EXT-X-DATERANGE")) {
        const l = line.toLowerCase();
        if (l.includes("stitched-ad") || l.includes("twitchad")) return false;
      }
      return true;
    }).join("\n");

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

// Proxy nested playlists and segments
app.get("/segment", async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).type("text").send("missing_u");

    const upstream = await fetch(u, { headers: { "X-Device-Id": DEVICE_ID } });
    if (!upstream.ok) throw new Error("upstream_" + upstream.status);

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");

    if (ct.includes("application/vnd.apple.mpegurl")) {
      let text = await upstream.text();

      // remove ad dateranges in child playlists too
      text = text.split("\n").filter(line => {
        if (line.startsWith("#EXT-X-DATERANGE")) {
          const l = line.toLowerCase();
          if (l.includes("stitched-ad") || l.includes("twitchad")) return false;
        }
        return true;
      }).join("\n");

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

    const buf = await upstream.arrayBuffer();
    return res.end(Buffer.from(buf));
  } catch (e) {
    console.error("segment_error:", e?.message || e);
    res.status(500).type("text").send(e?.message || "error");
  }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("server on :" + PORT));
