import express from 'express';

// ⚠️ Educational demo. Twitch can change things at any time.
// Use your own Client-ID from https://dev.twitch.tv/console/apps if possible.
const TWITCH_GQL = 'https://gql.twitch.tv/gql';
const USHER = 'https://usher.ttvnw.net/api/channel/hls';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // fallback public client id (may break anytime)

const app = express();

app.get('/health', (req, res) => res.type('text').send('ok'));

// Small CORS helper so your iPhone can call this from your hosted page
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 1) Get a clean HLS playlist for a channel and strip ad segments
app.get('/playlist/:channel', async (req, res) => {
  try{
    const login = String(req.params.channel || '').toLowerCase();
    if(!/^[a-z0-9_]{1,25}$/.test(login)) return res.status(400).send('bad channel');

    // Step A: fetch access token/signature via GQL
    const body = [{
      operationName: "PlaybackAccessToken",
      variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site" },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "0828119ded1c1323e9f9f8f9ccf0c9d2d2cfa2b7066ad9e3f1ab3d0d7f6f6f0a"
        }
      }
    }];
    const gql = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if(!gql.ok) return res.status(500).send('gql failed');
    const data = await gql.json();
    const tok = data?.[0]?.data?.streamPlaybackAccessToken;
    if(!tok?.signature || !tok?.value) return res.status(404).send('no token');

    // Step B: fetch HLS master m3u8 from Usher
    const url = new URL(`${USHER}/${encodeURIComponent(login)}.m3u8`);
    url.searchParams.set('sig', tok.signature);
    url.searchParams.set('token', tok.value);
    url.searchParams.set('allow_source', 'true');
    url.searchParams.set('allow_audio_only', 'true');
    url.searchParams.set('player', 'twitchweb');
    url.searchParams.set('p', String(Math.floor(Math.random()*1e7)));
    url.searchParams.set('client_id', CLIENT_ID);

    const m3u8Resp = await fetch(url, { headers: { 'Client-ID': CLIENT_ID } });
    if(!m3u8Resp.ok) return res.status(500).send('usher failed');
    let text = await m3u8Resp.text();

    // Step C: rewrite segment URIs through our /segment proxy and strip any ad dateranges
    // - Remove ad dateranges (common markers: CLASS="stitched-ad" or "TwitchAd")
    text = text.split('\n').filter(line => {
      if(line.startsWith('#EXT-X-DATERANGE')){
        const l = line.toLowerCase();
        if(l.includes('stitched-ad') || l.includes('twitchad')){
          return false; // drop ad markers
        }
      }
      return true;
    }).join('\n');

    // Also when returning a master playlist with variant URLs, we need to proxy those too
    const proxied = text.replace(/https?:\/\/[^\s]+/g, (u) => {
      return `${req.protocol}://${req.get('host')}/segment?u=${encodeURIComponent(u)}`;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(proxied);
  }catch(e){
    console.error(e);
    res.status(500).send('error');
  }
});

// 2) Proxy segments and nested playlists with CORS enabled
app.get('/segment', async (req, res) => {
  try{
    const u = req.query.u;
    if(!u) return res.status(400).send('missing u');
    const upstream = await fetch(u);
    if(!upstream.ok) return res.status(upstream.status).send('upstream error');

    // Pass through headers
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    // For playlists, also rewrite inside bodies to keep proxying consistent
    if((upstream.headers.get('content-type') || '').includes('application/vnd.apple.mpegurl')){
      let text = await upstream.text();
      // Remove ad dateranges again just in case
      text = text.split('\n').filter(line => {
        if(line.startsWith('#EXT-X-DATERANGE')){
          const l = line.toLowerCase();
          if(l.includes('stitched-ad') || l.includes('twitchad')) return false;
        }
        return true;
      }).join('\n');
      // Rewrite absolute URLs through this proxy
      const base = new URL(u);
      text = text.replace(/^(?!#)(.*\.m3u8.*|.*\.ts.*|https?:\/\/[^\s]+)$/gm, (line) => {
        line = line.trim();
        if(line.startsWith('#') || line === '') return line;
        // Make absolute
        let abs;
        try{ abs = new URL(line, base).toString(); } catch { abs = line; }
        return `${req.protocol}://${req.get('host')}/segment?u=${encodeURIComponent(abs)}`;
      });
      return res.send(text);
    }else{
      // Stream binary segments
      const buf = await upstream.arrayBuffer();
      return res.end(Buffer.from(buf));
    }
  }catch(e){
    console.error(e);
    res.status(500).send('error');
  }
});

// Serve static front-end (optional)
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('server on :' + PORT));
