// server.js (Render / Node 18+)
// Purpose: fetch Twitch HLS, remove ad markers, proxy all URLs, add better logging.

import express from 'express';

const TWITCH_GQL = 'https://gql.twitch.tv/gql';
const USHER = 'https://usher.ttvnw.net/api/channel/hls';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // fallback public client id

const app = express();

// CORS so iPhone Safari can fetch from your domain
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => res.type('text').send('ok'));

// Helper: ask Twitch GraphQL for a playback token/signature
async function getPlaybackToken(login) {
  // Primary persisted query (commonly used by web player)
  const body = [{
    operationName: 'PlaybackAccessToken',
    variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'site' },
    extensions: {
      persistedQuery: {
        version: 1,
        // NOTE: Twitch can rotate this. This one works frequently; if it stops, we try a fallback below.
        sha256Hash: '0828119ded1c1323e9f9f8f9ccf0c9d2d2cfa2b7066ad9e3f1ab3d0d7f6f6f0a'
      }
    }
  }];

  const h = {
  'Client-ID': CLIENT_ID,
  'GQL-Client-Id': CLIENT_ID,
  'Content-Type': 'application/json',
  'Origin': 'https://www.twitch.tv',
  'Referer': 'https://www.twitch.tv/'
};

  let r = await fetch(TWITCH_GQL, { method: 'POST', headers: h, body: JSON.stringify(body) });

  // If first attempt fails, try a slightly different playerType (fallback)
  if (!r.ok) {
    console.warn('GQL primary failed:', r.status);
    const fb = [{
      operationName: 'PlaybackAccessToken',
      variables: { isLive: true, login, isVod: false, vodID: '', playerType: 'embed' },
      extensions: body[0].extensions
    }];
    r = await fetch(TWITCH_GQL, { method: 'POST', headers: h, body: JSON.stringify(fb) });
  }
  if (!r.ok) throw new Error('gql_failed_' + r.status);

  const j = await r.json();
  const tok = j?.[0]?.data?.streamPlaybackAccessToken;
  if (!tok?.signature || !tok?.value) throw new Error('no_token');
  return tok;
}

// 1) Return a cleaned master playlist for a channel
app.get('/playlist/:channel', async (req, res) => {
  try {
    const login = String(req.params.channel || '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return res.status(400).type('text').send('bad_channel');

    // A) token+sig
    const tok = await getPlaybackToken(login);

    // B) fetch Usher master playlist
    const url = new URL(`${USHER}/${encodeURIComponent(login)}.m3u8`);
    url.searchParams.set('sig', tok.signature);
    url.searchParams.set('token', tok.value);
    url.searchParams.set('allow_source', 'true');
    url.searchParams.set('allow_audio_only', 'true');
    url.searchParams.set('player', 'twitchweb');
    url.searchParams.set('p', String(Math.floor(Math.random() * 1e7)));
    url.searchParams.set('client_id', CLIENT_ID);

    const up = await fetch(url, { headers: { 'Client-ID': CLIENT_ID } });
    if (!up.ok) throw new Error('usher_failed_' + up.status);
    let text = await up.text();

    // C) strip common ad dateranges
    text = text.split('\n').filter(line => {
      if (line.startsWith('#EXT-X-DATERANGE')) {
        const l = line.toLowerCase();
        if (l.includes('stitched-ad') || l.includes('twitchad')) return false;
      }
      return true;
    }).join('\n');

    // D) proxy any absolute URLs so iPhone can fetch with CORS
    const proxied = text.replace(/https?:\/\/[^\s]+/g, (u) =>
      `${req.protocol}://${req.get('host')}/segment?u=${encodeURIComponent(u)}`
    );

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(proxied);
  } catch (e) {
    console.error('playlist_error:', e?.message || e);
    res.status(500).type('text').send(e?.message || 'error');
  }
});

// 2) Proxy nested playlists and media segments
app.get('/segment', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).type('text').send('missing_u');

    const upstream = await fetch(u);
    if (!upstream.ok) throw new Error('upstream_' + upstream.status);

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-store');

    if (ct.includes('application/vnd.apple.mpegurl')) {
      let text = await upstream.text();
      // Strip ad markers again (for variant/rendition playlists)
      text = text.split('\n').filter(line => {
        if (line.startsWith('#EXT-X-DATERANGE')) {
          const l = line.toLowerCase();
          if (l.includes('stitched-ad') || l.includes('twitchad')) return false;
        }
        return true;
      }).join('\n');

      // Rewrite relative + absolute URLs through our proxy
      const base = new URL(u);
      text = text.replace(/^(?!#).*$/gm, (line) => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return s;
        let abs;
        try { abs = new URL(s, base).toString(); } catch { abs = s; }
        return `${req.protocol}://${req.get('host')}/segment?u=${encodeURIComponent(abs)}`;
      });
      return res.send(text);
    }

    const buf = await upstream.arrayBuffer();
    return res.end(Buffer.from(buf));
  } catch (e) {
    console.error('segment_error:', e?.message || e);
    res.status(500).type('text').send(e?.message || 'error');
  }
});

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('server on :' + PORT));
