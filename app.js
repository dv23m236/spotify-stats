require('dotenv').config(); // Lädt Variablen aus der .env-Datei (lokal) bzw. aus den Azure App Settings

const Express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const { CosmosClient } = require('@azure/cosmos');
const session = require('express-session'); // NEU: Session-Paket laden

const app = Express();
const port = process.env.PORT || 8000;

// Prüft beim Start, ob die wichtigsten Variablen gesetzt sind.
// So gibt's eine klare Fehlermeldung statt eines kryptischen Absturzes mitten im Betrieb.
const requiredEnvVars = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET'];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`--- [Fehler] Fehlende Umgebungsvariablen: ${missingEnvVars.join(', ')} ---`);
  console.error('--- Bitte eine .env-Datei anlegen (siehe .env.example) oder in den Azure App Settings setzen ---');
  process.exit(1);
}

// 1. Express-Session konfigurieren
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: !!process.env.WEBSITE_HOSTNAME, // Auf Azure (HTTPS) automatisch 'true', lokal 'false'
    maxAge: 3600000 // 1 Stunde Gültigkeit
  }
}));

// Verhindert, dass der Browser die API-Antworten im Cache speichert
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

const redirectUri = process.env.WEBSITE_HOSTNAME 
  ? `https://${process.env.WEBSITE_HOSTNAME}/` 
  : 'http://127.0.0.1:8000';

// HIER DIE ÄNDERUNG: Keine globalen Tokens mehr in dieser Instanz!
// Wir nutzen diese Instanz nur noch, um die Login-URLs zu generieren.
const spotifyCredentials = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri
};
const spotifyApiFactory = new SpotifyWebApi(spotifyCredentials);

// Funktion, um für JEDEN Request eine eigene Spotify-Instanz mit den User-Tokens zu bauen
function getUserSpotifyApi(req) {
  const userApi = new SpotifyWebApi(spotifyCredentials);
  if (req.session && req.session.accessToken) {
    userApi.setAccessToken(req.session.accessToken);
    userApi.setRefreshToken(req.session.refreshToken);
  }
  return userApi;
}

// ─── AZURE COSMOS DB CONFIG ──────────────────────────────────────────────────
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
let cosmosContainer = null;

if (cosmosEndpoint && cosmosKey) {
  const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });
  async function initCosmos() {
    try {
      const { database } = await client.databases.createIfNotExists({ id: 'SpotifyStats' });
      const { container } = await database.containers.createIfNotExists({
        id: 'HistoricalStats',
        partitionKey: { paths: ['/partitionKey'] }
      });
      cosmosContainer = container;
      console.log('--- [System] Cosmos DB erfolgreich initialisiert ---');
    } catch (err) {
      console.error('--- [Fehler] Cosmos DB Initialisierung fehlgeschlagen:', err);
    }
  }
  initCosmos();
} else {
  console.log('--- [System] Lokaler Modus ohne Azure Cosmos DB (Variablen fehlen) ---');
}

// ─── USER-SPEZIFISCHER CACHE ──────────────────────────────────────────────────
// Der Cache ist jetzt nach Session-IDs unterteilt, damit User A nicht die Daten von User B sieht!
const userCaches = {}; 

function getCachedData(sessionId, type, key) {
  if (!userCaches[sessionId]) return null;
  const entry = key ? userCaches[sessionId][type]?.[key] : userCaches[sessionId][type];
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

function setCachedData(sessionId, type, key, data, ttlMs) {
  if (!userCaches[sessionId]) userCaches[sessionId] = { topTracks: {}, topArtists: {}, recentlyPlayed: null };
  const expires = Date.now() + ttlMs;
  if (key) {
    userCaches[sessionId][type][key] = { data, expires };
  } else {
    userCaches[sessionId][type] = { data, expires };
  }
}

// ─── LOGIN & REDIRECT ─────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const scopes = ['user-read-recently-played', 'user-top-read', 'user-read-currently-playing', 'user-modify-playback-state', 'user-read-playback-state'];
  res.redirect(spotifyApiFactory.createAuthorizeURL(scopes));
});

app.get('/', (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Spotify Stats | Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap" rel="stylesheet">
        <style>
          body, html { margin: 0; padding: 0; height: 100%; font-family: 'Poppins', sans-serif; overflow: hidden; }
          .bg-overlay { position: fixed; top:0; left:0; width:100%; height:100%; background: linear-gradient(135deg,#0f0f0f 0%,#000 100%); z-index:-1; }
          
          .overlay { height:100%; display:flex; justify-content:center; align-items:center; padding: 20px; }
          
          .login-card { background:rgba(255,255,255,0.03); backdrop-filter:blur(20px); padding:60px; border-radius:30px; border:1px solid rgba(255,255,255,0.08); text-align:center; max-width:450px; width: 100%; box-shadow:0 25px 50px rgba(0,0,0,0.6); }
          
          h1 { color:white; font-size:42px; margin-bottom:10px; letter-spacing:-1px; }
          p { color:rgba(255,255,255,0.6); margin-bottom:40px; font-size:15px; line-height:1.6; }
          .btn { background:#1DB954; color:white; text-decoration:none; padding:16px 40px; border-radius:50px; font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:2px; transition:all 0.3s ease; display:inline-block; box-shadow:0 10px 20px rgba(29,185,84,0.2); }
          .btn:hover { transform:scale(1.03) translateY(-3px); box-shadow:0 15px 30px rgba(29,185,84,0.4); background:#1ed760; }

          @media (max-width: 480px) {
            .login-card { padding: 40px 20px; }
            h1 { font-size: 32px; }
          }
        </style>
      </head>
      <body>
        <div class="bg-overlay"></div>
        <div class="overlay">
          <div class="login-card">
            <img src="https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" width="65" style="margin-bottom:20px;">
            <h1>Insights.</h1>
            <p>Tauche tief in deine Hörgewohnheiten ein. Entdecke deine Top-Künstler und verfolge deine Musik live im Web-Dashboard.</p>
            <a href="/login" class="btn">Connect Spotify</a>
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Tokens in der Session des jeweiligen Nutzers abspeichern!
  spotifyApiFactory.authorizationCodeGrant(code)
    .then(data => {
      req.session.accessToken = data.body['access_token'];
      req.session.refreshToken = data.body['refresh_token'];
      req.session.tokenExpires = Date.now() + (data.body['expires_in'] * 1000);
      res.redirect('/stats');
    })
    .catch(err => res.send('Fehler beim Login: ' + (err.message || JSON.stringify(err))));
});

// Middleware, um das Token bei Bedarf vor API-Aufrufen im Hintergrund zu refreshen
async function checkAndRefreshUserToken(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.redirect('/login');
  }
  // Falls das Token in weniger als 5 Minuten abläuft, refreshen
  if (req.session.tokenExpires && Date.now() > req.session.tokenExpires - 300000) {
    try {
      const userApi = getUserSpotifyApi(req);
      const data = await userApi.refreshAccessToken();
      req.session.accessToken = data.body['access_token'];
      req.session.tokenExpires = Date.now() + (3600 * 1000);
      console.log(`--- [System] Token für Session ${req.session.id} erneuert ---`);
    } catch (err) {
      console.error('Fehler beim automatischen User-Token-Refresh:', err.message);
    }
  }
  next();
}

// Player-Steuerungs-Endpunkt (Session-safe)
app.get('/api/control/:action', checkAndRefreshUserToken, async (req, res) => {
  try {
    const userApi = getUserSpotifyApi(req);
    const action = req.params.action;
    if (action === 'next') await userApi.skipToNext();
    if (action === 'prev') await userApi.skipToPrevious();
    if (action === 'toggle') {
      const state = await userApi.getMyCurrentPlaybackState().catch(() => null);
      if (state && state.body && state.body.is_playing) await userApi.pause();
      else await userApi.play();
    }
    if (action === 'seek') {
      const positionMs = parseInt(req.query.position);
      if (!isNaN(positionMs)) await userApi.seek(positionMs);
    }
    return res.json({ success: true });
  } catch (err) {
    if (err.message && err.message.includes('PREMIUM_REQUIRED')) return res.json({ success: false, reason: 'premium_required' });
    return res.status(500).json({ error: err.message || 'Internal Error' });
  }
});

// Live-Player-Daten-Endpunkt (Session-safe)
app.get('/api/now-playing', checkAndRefreshUserToken, async (req, res) => {
  try {
    const userApi = getUserSpotifyApi(req);
    const sessionId = req.session.id;

    const data = await userApi.getMyCurrentPlayingTrack().catch(() => null);
    if (data && data.body && data.body.item) {
      const track = data.body.item;
      
      // Hintergrund-Cosmos-Sync (nur wenn DB an ist)
      if (cosmosContainer) {
        if (req.session.lastTrackId !== track.id) {
          req.session.lastTrackId = track.id;
          await cosmosContainer.items.create({
            id: track.id + "_" + Date.now(),
            title: track.name,
            artist: track.artists[0].name,
            playedAt: new Date().toISOString(),
            partitionKey: 'spotify-history'
          }).catch(() => null);
        }
      }

      return res.json({
        hasActiveSession: true,
        isPlaying: data.body.is_playing,
        title: track.name,
        artist: track.artists && track.artists[0] ? track.artists[0].name : 'Unbekannter Künstler',
        image: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : 'https://via.placeholder.com/150',
        progressMs: data.body.progress_ms,
        durationMs: track.duration_ms
      });
    }

    let lastTrack = null;
    const cachedRecent = getCachedData(sessionId, 'recentlyPlayed', null);
    if (cachedRecent) {
      lastTrack = cachedRecent.items && cachedRecent.items[0] ? cachedRecent.items[0].track : null;
    } else {
      const recent = await userApi.getMyRecentlyPlayedTracks({ limit: 1 }).catch(() => null);
      if (recent && recent.body) {
        setCachedData(sessionId, 'recentlyPlayed', null, recent.body, 120000);
        lastTrack = recent.body.items && recent.body.items[0] ? recent.body.items[0].track : null;
      }
    }
    if (lastTrack) {
      return res.json({
        hasActiveSession: false,
        isPlaying: false,
        title: lastTrack.name,
        artist: lastTrack.artists && lastTrack.artists[0] ? lastTrack.artists[0].name : 'Unbekannter Künstler',
        image: lastTrack.album && lastTrack.album.images && lastTrack.album.images[0] ? lastTrack.album.images[0].url : 'https://via.placeholder.com/150'
      });
    }
    return res.json({ hasActiveSession: false, isPlaying: false });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal Error' });
  }
});

// ─── STATS DASHBOARD (Session-safe) ──────────────────────────────────────────
app.get('/stats', checkAndRefreshUserToken, async (req, res) => {
  try {
    const userApi = getUserSpotifyApi(req);
    const sessionId = req.session.id;

    let timeRange = req.query.range || 'medium_term';
    if (!['short_term', 'medium_term', 'long_term'].includes(timeRange)) timeRange = 'medium_term';

    let userLimit = parseInt(req.query.limit) || 20;
    if (![10, 20, 30].includes(userLimit)) userLimit = 20;

    let recentLimit = parseInt(req.query.recentLimit) || 5;
    if (![5, 10].includes(recentLimit)) recentLimit = 5;

    // NEU: Holt die aktuelle Unterseite aus der URL (Standard: page-home)
    let currentPage = req.query.page || 'page-home';

    let cachedTracks = getCachedData(sessionId, 'topTracks', timeRange);
    let cachedArtists = getCachedData(sessionId, 'topArtists', timeRange);
    let cachedRecent = getCachedData(sessionId, 'recentlyPlayed', null);

    if (!cachedTracks) {
      try {
        const r = await userApi.getMyTopTracks({ limit: 40, time_range: timeRange });
        cachedTracks = r.body;
        setCachedData(sessionId, 'topTracks', timeRange, cachedTracks, 600000);
      } catch (err) {
        console.error("❌ Fehler Top-Tracks:", err.message);
        cachedTracks = { items: [] };
      }
    }

    if (!cachedArtists) {
      try {
        const r = await userApi.getMyTopArtists({ limit: 40, time_range: timeRange });
        cachedArtists = r.body;
        setCachedData(sessionId, 'topArtists', timeRange, cachedArtists, 600000);
      } catch (err) {
        console.error("❌ Fehler Top-Künstler:", err.message);
        cachedArtists = { items: [] };
      }
    }

    if (!cachedRecent) {
      try {
        const r = await userApi.getMyRecentlyPlayedTracks({ limit: 10 });
        cachedRecent = r.body;
        setCachedData(sessionId, 'recentlyPlayed', null, cachedRecent, 120000);
      } catch (err) {
        console.error("❌ Fehler Verlauf:", err.message);
        cachedRecent = { items: [] };
      }
    }

    const activeShort  = timeRange === 'short_term'  ? 'active' : '';
    const activeMedium = timeRange === 'medium_term' ? 'active' : '';
    const activeLong   = timeRange === 'long_term'   ? 'active' : '';

    const allTracks    = (cachedTracks && cachedTracks.items)  ? cachedTracks.items  : [];
    const allArtists   = (cachedArtists && cachedArtists.items) ? cachedArtists.items : [];
    const tracksArray  = allTracks.slice(0, userLimit);
    const artistsArray = allArtists.slice(0, userLimit);
    const recentArray  = (cachedRecent && cachedRecent.items)   ? cachedRecent.items.slice(0, recentLimit) : [];

    // Minispiel-Pools generieren
    const quizPool = allTracks.map(t => ({
      title:  t.name,
      artist: t.artists && t.artists[0] ? t.artists[0].name : 'Unbekannt',
      image:  t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : 'https://via.placeholder.com/300'
    })).filter(t => t.title && t.artist);

    // Pool für das Release-Jahr-Quiz: Albumcover, Songtitel & echtes Erscheinungsjahr
    const yearPool = allTracks.map(t => {
      const releaseDate = t.album && t.album.release_date ? t.album.release_date : null;
      const releaseYear = releaseDate ? parseInt(releaseDate.substring(0, 4), 10) : NaN;
      return {
        title:  t.name,
        artist: t.artists && t.artists[0] ? t.artists[0].name : 'Unbekannt',
        image:  t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : 'https://via.placeholder.com/300',
        year:   releaseYear
      };
    }).filter(t => t.title && !isNaN(t.year));

    const base64QuizPool = Buffer.from(encodeURIComponent(JSON.stringify(quizPool))).toString('base64');
    const base64YearPool = Buffer.from(encodeURIComponent(JSON.stringify(yearPool))).toString('base64');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
        <style>
          * { box-sizing: border-box; }
          body { background:#000; color:white; font-family:'Poppins',sans-serif; margin:0; min-height:100vh; overflow-x:hidden; display:flex; }
          #dynamic-bg { position:fixed; top:-5%; left:-5%; width:110%; height:110%; z-index:-2; background-size:cover; background-position:center; filter:blur(45px) brightness(0.35); transition:background-image 1.2s ease-in-out; }
          #dark-overlay { position:fixed; top:0; left:0; width:100%; height:100%; z-index:-1; background:linear-gradient(180deg,rgba(0,0,0,0.1) 0%,#000 85%); }
          
          /* Sidebar */
          .sidebar { width:260px; height:100vh; background:rgba(0,0,0,0.6); backdrop-filter:blur(20px); border-right:1px solid rgba(255,255,255,0.05); position:fixed; top:0; left:0; padding:30px 20px; display:flex; flex-direction:column; z-index:10; }
          .logo-area { display:flex; align-items:center; gap:12px; margin-bottom:40px; padding-left:10px; }
          .logo-area h2 { font-size:20px; font-weight:700; letter-spacing:-0.5px; margin:0; }
          .nav-menu { list-style:none; padding:0; margin:0; flex-grow:1; }
          .nav-item { display:flex; align-items:center; gap:15px; padding:14px 18px; color:#b3b3b3; text-decoration:none; border-radius:12px; font-weight:600; font-size:14px; margin-bottom:8px; cursor:pointer; transition:all 0.2s ease; }
          .nav-item:hover, .nav-item.active { color:white; background:rgba(255,255,255,0.08); }
          .nav-item.active i { color:#1DB954; }
          
          /* Layout */
          .main-content { margin-left:260px; flex-grow:1; padding:40px 50px 100px; min-height:100vh; }
          .app-page { display:none; }
          .app-page.active { display:block; animation:fadeIn 0.4s ease; }
          @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
          
          /* Filter Bar */
          .filter-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:35px; width:100%; max-width:1000px; }
          .tab-container { display:flex; gap:10px; background:rgba(255,255,255,0.03); padding:6px; border-radius:30px; border:1px solid rgba(255,255,255,0.05); }
          .tab-btn { padding:8px 22px; color:#b3b3b3; text-decoration:none; border-radius:20px; font-weight:600; font-size:13px; transition:all 0.2s; }
          .tab-btn:hover { color:white; }
          .tab-btn.active { background:#1DB954; color:white; }
          
          /* Live Player Card */
          #live-container { margin-bottom:40px; min-height:180px; }
          .live-card { background:rgba(255,255,255,0.03); backdrop-filter:blur(15px); border-radius:20px; padding:30px; display:flex; align-items:center; gap:30px; border:1px solid rgba(255,255,255,0.08); position:relative; box-shadow:0 20px 50px rgba(0,0,0,0.4); }
          .cover-art { width:150px; height:150px; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.6); object-fit:cover; }
          .info { flex-grow:1; }
          .label-wrapper { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
          .live-label { font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:2px; color:#1DB954; }
          .wave-container { display:flex; align-items:flex-end; gap:3px; height:14px; width:20px; }
          .wave-bar { width:3px; height:2px; background:#1DB954; border-radius:2px; animation:bounce 1s ease-in-out infinite alternate; }
          .wave-bar:nth-child(2) { animation-delay:0.2s; }
          .wave-bar:nth-child(3) { animation-delay:0.4s; }
          @keyframes bounce { 0% { height:2px; } 100% { height:14px; } }
          .track-name { font-size:30px; font-weight:700; margin:2px 0; letter-spacing:-0.5px; }
          .artist-name { color:#b3b3b3; font-size:17px; margin-bottom:18px; }
          
          /* Controls */
          .controls { display:flex; align-items:center; gap:22px; margin-bottom:12px; }
          .ctrl-btn { background:none; border:none; color:#b3b3b3; font-size:22px; cursor:pointer; transition:all 0.2s; }
          .ctrl-btn:hover { color:white; transform:scale(1.1); }
          .ctrl-btn.play { font-size:40px; color:#1DB954; }
          .ctrl-btn.play:hover { color:#1ed760; }
          .premium-warning { display:none; color:#ff5252; font-size:13px; font-weight:600; margin-bottom:12px; }
          
          /* Progress Bar */
          .progress-area { max-width:500px; display:flex; align-items:center; gap:12px; color:#a7a7a7; font-size:11px; }
          .bar-bg { flex-grow:1; height:6px; background:rgba(255,255,255,0.15); border-radius:3px; cursor:pointer; }
          .bar-fill { height:100%; background:#1DB954; width:0%; border-radius:3px; pointer-events:none; }
          
          /* Grids & Cards */
          .section-title { font-size:24px; margin-top:40px; margin-bottom:25px; font-weight:700; letter-spacing:-0.5px; display:flex; align-items:center; gap:10px; }
          .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:25px; margin-bottom:40px; }
          .card { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.04); padding:18px; border-radius:16px; transition:all 0.3s cubic-bezier(0.4,0,0.2,1); text-align:center; position:relative; }
          .card:hover { background:rgba(255,255,255,0.06); border-color:rgba(255,255,255,0.1); transform:translateY(-5px); }
          .card img { width:100%; aspect-ratio:1; border-radius:10px; object-fit:cover; margin-bottom:14px; box-shadow:0 8px 20px rgba(0,0,0,0.4); }
          .rank { position:absolute; top:10px; left:10px; background:#1DB954; color:black; font-weight:700; padding:2px 10px; border-radius:20px; font-size:11px; }
          .card-title { font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:2px; }
          .card-sub { color:#b3b3b3; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          
          /* Verlauf-Liste */
          .recent-list { background:rgba(255,255,255,0.02); border-radius:16px; border:1px solid rgba(255,255,255,0.04); overflow:hidden; margin-bottom:40px; }
          .recent-item { display:flex; align-items:center; gap:20px; padding:14px 24px; border-bottom:1px solid rgba(255,255,255,0.04); }
          .recent-item:last-child { border-bottom:none; }
          .recent-item img { width:50px; height:50px; border-radius:8px; object-fit:cover; }
          .recent-info { flex-grow:1; }
          .recent-title { font-weight:600; font-size:15px; }
          .recent-artist { color:#b3b3b3; font-size:13px; }
          
          /* QUIZ STYLES */
          .quiz-card { 
            background: rgba(255, 255, 255, 0.03); 
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.08); 
            border-radius: 24px; 
            padding: 40px; 
            max-width: 650px; 
            text-align: center; 
            margin: 20px auto; 
            box-shadow: 0 30px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1);
            transition: border-color 0.3s ease;
          }
          
          .quiz-card h2 {
            font-size: 26px;
            font-weight: 700;
            margin-top: 0;
            margin-bottom: 20px;
            letter-spacing: -0.5px;
          }
          
          .quiz-img-wrapper {
            position: relative;
            display: inline-block;
            margin-bottom: 30px;
          }
          
          .quiz-img { 
            width: 240px; 
            height: 240px; 
            border-radius: 18px; 
            object-fit: cover; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.7);
            transition: transform 0.3s ease;
          }
          
          .quiz-card:hover .quiz-img {
            transform: scale(1.02);
          }
          
          .quiz-options { 
            display: grid; 
            grid-template-columns: 1fr; 
            gap: 12px; 
            margin-top: 25px; 
          }
          
          .quiz-btn { 
            background: rgba(255, 255, 255, 0.04); 
            border: 1px solid rgba(255, 255, 255, 0.08); 
            color: #e5e5e5; 
            padding: 16px 24px; 
            border-radius: 14px; 
            font-weight: 600; 
            cursor: pointer; 
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); 
            font-size: 14px; 
            text-align: left; 
            display: flex;
            align-items: center;
            gap: 15px;
          }
          
          .quiz-btn:hover { 
            background: rgba(29, 185, 84, 0.1); 
            border-color: #1DB954; 
            color: white;
            transform: translateX(4px);
            box-shadow: 0 4px 20px rgba(29, 185, 84, 0.15);
          }
          
          .quiz-score { 
            font-size: 15px; 
            font-weight: 700; 
            color: #1DB954; 
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 25px; 
            background: rgba(29, 185, 84, 0.1);
            display: inline-block;
            padding: 6px 16px;
            border-radius: 20px;
          }
          
          /* Höher / Tiefer Spiel */
          .higher-lower-grid { 
            display: grid; 
            grid-template-columns: 1fr 1fr; 
            gap: 25px; 
            align-items: stretch; 
          }
          
          .hl-choice { 
            background: rgba(255, 255, 255, 0.02); 
            padding: 35px 25px; 
            border-radius: 20px; 
            border: 1px solid rgba(255, 255, 255, 0.06); 
            text-align: center; 
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: center;
            transition: all 0.3s ease;
          }
          
          .hl-choice:hover {
            background: rgba(255, 255, 255, 0.04);
            border-color: rgba(255, 255, 255, 0.12);
          }
          
          .hl-choice img {
            width: 140px;
            height: 140px;
            border-radius: 50%; 
            object-fit: cover;
            margin-bottom: 15px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            border: 2px solid rgba(255,255,255,0.1);
          }

          .hl-choice h3 {
            font-size: 20px;
            margin: 10px 0 5px 0;
            font-weight: 700;
          }
          
          .hl-btn { 
            background: #1DB954; 
            color: black; 
            border: none; 
            padding: 14px 35px; 
            border-radius: 30px; 
            font-weight: 700; 
            cursor: pointer; 
            margin: 8px; 
            font-size: 12px; 
            text-transform: uppercase; 
            letter-spacing: 1.5px; 
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); 
            box-shadow: 0 6px 20px rgba(29,185,84,0.2);
          }
          
          .hl-btn:hover { 
            background: #1ed760; 
            transform: scale(1.05) translateY(-2px); 
            box-shadow: 0 10px 25px rgba(29,185,84,0.4);
          }

          .hl-vs {
            font-size: 22px;
            font-weight: 800;
            color: rgba(255,255,255,0.3);
            font-style: italic;
            margin: 15px 0;
          }

          /* Release-Jahr-Quiz: Zeitstrahl-Slider */
          .year-slider-wrapper {
            margin: 30px auto 10px;
            max-width: 480px;
          }

          .year-display {
            font-size: 48px;
            font-weight: 800;
            color: #1DB954;
            letter-spacing: 2px;
            margin-bottom: 18px;
          }

          .year-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 8px;
            border-radius: 4px;
            background: linear-gradient(90deg, rgba(29,185,84,0.12), rgba(29,185,84,0.5));
            outline: none;
            cursor: pointer;
          }

          .year-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            background: #1DB954;
            cursor: pointer;
            border: 2px solid #ffffff;
            box-shadow: 0 4px 14px rgba(29,185,84,0.5);
            transition: transform 0.15s ease;
          }

          .year-slider::-webkit-slider-thumb:hover {
            transform: scale(1.1);
          }

          .year-slider::-moz-range-thumb {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            background: #1DB954;
            cursor: pointer;
            border: 2px solid #ffffff;
            box-shadow: 0 4px 14px rgba(29,185,84,0.5);
          }

          .year-slider:disabled::-webkit-slider-thumb {
            background: #777;
            box-shadow: none;
          }

          .year-slider:disabled::-moz-range-thumb {
            background: #777;
            box-shadow: none;
          }

          .year-slider-labels {
            display: flex;
            justify-content: space-between;
            color: #b3b3b3;
            font-size: 13px;
            margin-top: 10px;
            font-weight: 600;
          }
            
          /* ==========================================
             MODERN MOBILE MODE UPGRADE + LISTEN-LOOK
             ========================================== */
          body.mobile-mode {
            flex-direction: column !important;
            display: flex !important;
            background: #0c0c0c !important; /* Etwas tieferes Schwarz */
          }
          
          /* Sidebar wird zur eleganten Top-Bar (kompakt) */
          body.mobile-mode .sidebar {
            width: 100% !important;
            height: auto !important;
            position: sticky !important;
            top: 0 !important;
            left: 0 !important;
            border-right: none !important;
            border-bottom: 1px solid rgba(255,255,255,0.08) !important;
            padding: 15px 20px !important;
            background: rgba(12, 12, 12, 0.85) !important;
            backdrop-filter: blur(25px) !webkit-backdrop-filter: blur(25px) !important;
            display: flex !important;
            flex-direction: row !important;
            justify-content: space-between !important;
            align-items: center !important;
            z-index: 999 !important;
          }
          
          body.mobile-mode .logo-area {
            margin-bottom: 0 !important;
            padding-left: 0 !important;
          }

          body.mobile-mode .logo-area h2 {
            font-size: 18px !important;
          }
          
          /* Die Menüpunkte werden zu einer sauberen horizontalen Scroll-Leiste */
          body.mobile-mode .nav-menu {
            display: flex !important;
            flex-direction: row !important;
            gap: 6px !important;
            overflow-x: auto !important;
            white-space: nowrap !important;
            padding-bottom: 3px !important;
            max-width: 70% !important;
            /* Versteckt die Scrollbar für sauberen Look */
            -ms-overflow-style: none;
            scrollbar-width: none;
          }
          body.mobile-mode .nav-menu::-webkit-scrollbar { display: none; }
          
          body.mobile-mode .nav-item {
            margin-bottom: 0 !important;
            padding: 8px 14px !important;
            font-size: 12px !important;
            background: rgba(255,255,255,0.04) !important;
            border-radius: 20px !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 8px !important;
          }

          body.mobile-mode #view-toggle-btn {
            background: rgba(29, 185, 84, 0.1) !important;
            color: #1DB954 !important;
          }
          
          /* Hauptinhalt bekommt mehr Luft */
          body.mobile-mode .main-content {
            margin-left: 0 !important;
            padding: 20px 15px 100px 15px !important;
            width: 100% !important;
          }
          
          /* Filterleiste stylen: Zeitfilter oben, Dropdowns elegant darunter */
          body.mobile-mode .filter-bar {
            flex-direction: column !important;
            gap: 15px !important;
            align-items: stretch !important;
            width: 100% !important;
          }

          body.mobile-mode .tab-container {
            width: 100% !important;
            display: flex !important;
            justify-content: space-between !important;
          }

          body.mobile-mode .tab-btn {
            flex: 1 !important;
            text-align: center !important;
            padding: 8px 5px !important;
            font-size: 12px !important;
          }

          /* Dropdowns nebeneinander strecken */
          body.mobile-mode .filter-bar > div:last-child {
            display: flex !important;
            width: 100% !important;
            gap: 10px !important;
          }

          body.mobile-mode #dropdown-limit, 
          body.mobile-mode #dropdown-recent {
            flex: 1 !important;
            justify-content: space-between !important;
            background: rgba(255,255,255,0.03) !important;
            padding: 8px 12px !important;
            border-radius: 12px !important;
            border: 1px solid rgba(255,255,255,0.05) !important;
          }
          
          body.mobile-mode select {
            background: transparent !important;
            border: none !important;
            padding: 0 !important;
            font-size: 13px !important;
          }

          /* Live-Player auf Handys extrem schick machen */
          body.mobile-mode .live-card {
            flex-direction: row !important; /* Bild links, Text rechts statt Untereinander */
            align-items: center !important;
            text-align: left !important;
            padding: 16px !important;
            gap: 16px !important;
          }

          body.mobile-mode .cover-art {
            width: 80px !important;
            height: 80px !important;
            border-radius: 8px !important;
          }

          body.mobile-mode .track-name {
            font-size: 18px !important;
            line-height: 1.2 !important;
          }

          body.mobile-mode .artist-name {
            font-size: 14px !important;
            margin-bottom: 8px !important;
          }

          body.mobile-mode .controls {
            gap: 15px !important;
          }

          body.mobile-mode .ctrl-btn {
            font-size: 18px !important;
          }

          body.mobile-mode .ctrl-btn.play {
            font-size: 30px !important;
          }
          
          /* Minispiele-Grid auf Mobilgeräten */
          body.mobile-mode .higher-lower-grid {
            grid-template-columns: 1fr !important;
            gap: 15px !important;
          }

          /* -------------------------------------------
             AB HIER: NEUER ERGÄNZTER LISTEN-LOOK 
             ------------------------------------------- */

          /* Macht den Song-Verlauf (Home) zu einer sauberen Liste */
          body.mobile-mode .recent-list {
            display: flex !important;
            flex-direction: column !important;
            gap: 10px !important;
            padding: 0 5px !important;
          }

          body.mobile-mode .recent-item {
            flex-direction: row !important; /* Bild links, Text rechts */
            align-items: center !important;
            background: rgba(255, 255, 255, 0.03) !important;
            padding: 10px 12px !important;
            border-radius: 8px !important;
            gap: 15px !important;
          }

          body.mobile-mode .recent-item img {
            width: 50px !important;
            height: 50px !important;
            border-radius: 4px !important;
          }

          body.mobile-mode .recent-info {
            text-align: left !important;
          }

          body.mobile-mode .recent-title {
            font-size: 14px !important;
            font-weight: 600 !important;
            margin-bottom: 2px !important;
          }

          body.mobile-mode .recent-artist {
            font-size: 12px !important;
            color: #b3b3b3 !important;
          }

          /* Wandelt das große Kachel-Grid der Top-Listen in Zeilen um */
          body.mobile-mode .grid {
            display: flex !important;
            flex-direction: column !important; /* Zeilen untereinander statt Grid */
            gap: 10px !important;
          }

          body.mobile-mode .card {
            display: flex !important;
            flex-direction: row !important; /* Bild links, Text rechts */
            align-items: center !important;
            padding: 10px 12px !important;
            border-radius: 8px !important;
            gap: 15px !important;
            background: rgba(255, 255, 255, 0.03) !important;
            text-align: left !important;
          }

          body.mobile-mode .card img {
            width: 50px !important;
            height: 50px !important;
            border-radius: 4px !important;
            object-fit: cover !important;
          }

          body.mobile-mode .card-title {
            font-size: 14px !important;
            font-weight: 600 !important;
          }
        </style>
      </head>
      <body>
        <div id="dynamic-bg"></div>
        <div id="dark-overlay"></div>
        
        <div class="sidebar">
          <div class="logo-area"><img src="https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" width="30"><h2>Insights.</h2></div>
          <ul class="nav-menu">
            <li id="nav-page-home" class="nav-item active" onclick="switchPage('page-home')"><i class="fas fa-home"></i> Home</li>
            <li id="nav-page-tracks" class="nav-item" onclick="switchPage('page-tracks')"><i class="fas fa-music"></i> Top Tracks</li>
            <li id="nav-page-artists" class="nav-item" onclick="switchPage('page-artists')"><i class="fas fa-microphone"></i> Top Künstler</li>
            <li id="nav-page-games" class="nav-item" onclick="switchPage('page-games')"><i class="fas fa-gamepad"></i> Minispiele</li>
            
            <li style="border-top: 1px solid rgba(255,255,255,0.1); margin: 15px 0; list-style: none;"></li>
            <li id="view-toggle-btn" class="nav-item" style="cursor: pointer;"><i class="fas fa-mobile-alt"></i> Handy-Ansicht</li>
          </ul>
        </div>
        
        <div class="main-content">
          <div class="filter-bar" id="global-filter-bar" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 35px; width: 100%; max-width: 1000px;">
            <div class="tab-container">
              <a href="/stats?range=short_term&limit=${userLimit}&recentLimit=${recentLimit}" class="tab-btn ${activeShort}">Letzter Monat</a>
              <a href="/stats?range=medium_term&limit=${userLimit}&recentLimit=${recentLimit}" class="tab-btn ${activeMedium}">6 Monate</a>
              <a href="/stats?range=long_term&limit=${userLimit}&recentLimit=${recentLimit}" class="tab-btn ${activeLong}">All Time</a>
            </div>
            
            <div style="display: flex; gap: 20px; align-items: center;">
              <div id="dropdown-limit" style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 12px; color: #b3b3b3; font-weight: 500;">Anzeigen:</span>
                <select onchange="const p = new URLSearchParams(window.location.search).get('page') || 'page-home'; window.location.href = this.value + '&page=' + p;" style="background: rgba(255,255,255,0.05); color: white; border: 1px solid rgba(255,255,255,0.1); padding: 5px 12px; border-radius: 20px; font-family: 'Poppins', sans-serif; font-size: 12px; cursor: pointer; outline: none;">
                  <option value="/stats?range=${timeRange}&limit=10&recentLimit=${recentLimit}" ${userLimit === 10 ? 'selected' : ''}>10 Einträge</option>
                  <option value="/stats?range=${timeRange}&limit=20&recentLimit=${recentLimit}" ${userLimit === 20 ? 'selected' : ''}>20 Einträge</option>
                  <option value="/stats?range=${timeRange}&limit=30&recentLimit=${recentLimit}" ${userLimit === 30 ? 'selected' : ''}>30 Einträge</option>
                </select>
              </div>
              
              <div id="dropdown-recent" style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 12px; color: #b3b3b3; font-weight: 500;">Verlauf:</span>
                <select onchange="const p = new URLSearchParams(window.location.search).get('page') || 'page-home'; window.location.href = this.value + '&page=' + p;" style="background: rgba(255,255,255,0.05); color: white; border: 1px solid rgba(255,255,255,0.1); padding: 5px 12px; border-radius: 20px; font-family: 'Poppins', sans-serif; font-size: 12px; cursor: pointer; outline: none;">
                  <option value="/stats?range=${timeRange}&limit=${userLimit}&recentLimit=5" ${recentLimit === 5 ? 'selected' : ''}>5 Songs</option>
                  <option value="/stats?range=${timeRange}&limit=${userLimit}&recentLimit=10" ${recentLimit === 10 ? 'selected' : ''}>10 Songs</option>
                </select>
              </div>
            </div>
          </div>
          
          <div id="page-home" class="app-page">
            <div id="live-container"><div class="live-card">Synchronisiere Live-Player...</div></div>
            <h2 class="section-title"><i class="fas fa-history"></i> Kürzlich gehört</h2>
            <div class="recent-list">
              ${recentArray.length > 0 ? recentArray.map(item => {
                const rImg = item.track && item.track.album && item.track.album.images && item.track.album.images[0] ? item.track.album.images[0].url : 'https://via.placeholder.com/150';
                return `
                  <div class="recent-item">
                    <img src="${rImg}">
                    <div class="recent-info">
                      <div class="recent-title">${item.track ? item.track.name : 'Unbekannt'}</div>
                      <div class="recent-artist">${item.track && item.track.artists && item.track.artists[0] ? item.track.artists[0].name : 'Unbekannt'}</div>
                    </div>
                  </div>`;
              }).join('') : '<p style="color:#535353; padding:20px;">Kein Verlauf vorhanden</p>'}
            </div>
          </div>

          <div id="page-tracks" class="app-page">
            <h2 class="section-title"><i class="fas fa-music"></i> Deine Top Tracks</h2>
            <div class="grid">
              ${tracksArray.length > 0 ? tracksArray.map((t, i) => `
                <div class="card"><span class="rank">#${i + 1}</span><img src="${t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : 'https://via.placeholder.com/150'}">
                  <div class="card-title">${t.name}</div><div class="card-sub">${t.artists && t.artists[0] ? t.artists[0].name : 'Künstler'}</div>
                </div>`).join('') : '<p style="color:#535353; padding-left:15px;">Keine Daten verfügbar</p>'}
            </div>
          </div>

          <div id="page-artists" class="app-page">
            <h2 class="section-title"><i class="fas fa-microphone"></i> Deine Lieblingskünstler</h2>
            <div class="grid">
              ${artistsArray.length > 0 ? artistsArray.map((a, i) => `
                <div class="card"><span class="rank">#${i + 1}</span><img src="${a.images && a.images[0] ? a.images[0].url : 'https://via.placeholder.com/150'}" style="border-radius:50%;">
                  <div class="card-title">${a.name}</div><div class="card-sub">${a.genres && a.genres[0] ? a.genres[0] : 'Künstler'}</div>
                </div>`).join('') : '<p style="color:#535353; padding-left:15px;">Keine Daten verfügbar</p>'}
            </div>
          </div>

          <div id="page-games" class="app-page">
            <h2 class="section-title"><i class="fas fa-gamepad"></i> Musik-Minispiele</h2>
            <div style="display:flex; justify-content:center; gap:20px; margin-bottom:30px;">
              <button class="hl-btn" onclick="startSongQuiz()">Song-Erkennungs-Quiz</button>
              <button class="hl-btn" onclick="startYearQuiz()">Release-Jahr-Quiz</button>
            </div>
            <div id="game-arena">
              <p style="text-align:center; color:#b3b3b3;">Wähle oben ein Minispiel aus, um zu starten!</p>
            </div>
          </div>
        </div>

        <script>
          let isPlayingLive = false, isFetchPending = false;
          let localProgress = 0, localDuration = 0, lastLoadedImage = '';
          let premiumWarningUntil = 0;

          const quizPool = JSON.parse(decodeURIComponent(atob("${base64QuizPool}")));
          const yearPool = JSON.parse(decodeURIComponent(atob("${base64YearPool}")));

          function switchPage(pageId) {
            // 1. Alle Seiten ausblenden
            const pages = ['page-home', 'page-tracks', 'page-artists', 'page-minigames', 'page-games'];
            pages.forEach(p => {
              const el = document.getElementById(p);
              if (el) el.style.display = 'none';
            });

            // 2. Die gewünschte Seite einblenden
            const activePage = document.getElementById(pageId);
            if (activePage) {
              activePage.style.display = 'block';
            }

            // 3. Aktiven Navigations-Punkt umschalten
            const items = document.querySelectorAll('.nav-item');
            items.forEach(item => item.classList.remove('active'));

            if (pageId === 'page-home') {
              const nav = document.getElementById('nav-home');
              if (nav) nav.classList.add('active');
            } else if (pageId === 'page-tracks') {
              const nav = document.getElementById('nav-tracks');
              if (nav) nav.classList.add('active');
            } else if (pageId === 'page-artists') {
              const nav = document.getElementById('nav-artists');
              if (nav) nav.classList.add('active');
            } else if (pageId === 'page-minigames' || pageId === 'page-games') {
              const nav = document.getElementById('nav-minigames') || document.getElementById('nav-page-minigames');
              if (nav) nav.classList.add('active');
            }

            // 4. KLUGE FILTER-STEUERUNG: Zeitfilter auf Home und Minigames komplett verstecken!
            const filterBar = document.getElementById('global-filter-bar');
            const dropLimit = document.getElementById('dropdown-limit');
            const dropRecent = document.getElementById('dropdown-recent');

            if (pageId === 'page-tracks' || pageId === 'page-artists') {
              // Nur bei den Top-Listen zeigen wir die Leiste und das Eintrags-Limit
              if (filterBar) filterBar.style.setProperty('display', 'flex', 'important');
              if (dropLimit) dropLimit.style.setProperty('display', 'flex', 'important');
              if (dropRecent) dropRecent.style.setProperty('display', 'none', 'important');
            } else if (pageId === 'page-home') {
              // Auf Home blenden wir die Zeit-Pillen aus, zeigen aber das Verlaufs-Limit rechts!
              if (filterBar) filterBar.style.setProperty('display', 'flex', 'important');
              // Trick: Wir verstecken die Buttons (tab-container) im CSS, lassen das Dropdown aber da
              const tabContainer = document.querySelector('.tab-container');
              if (tabContainer) tabContainer.style.setProperty('display', 'none', 'important');
              
              if (dropLimit) dropLimit.style.setProperty('display', 'none', 'important');
              if (dropRecent) dropRecent.style.setProperty('display', 'flex', 'important');
            } else {
              // Bei Minigames fliegt die komplette Filterleiste raus
              if (filterBar) filterBar.style.setProperty('display', 'none', 'important');
            }

            // Wenn wir von Home weggehen, sorgen wir dafür, dass die Pillen wieder eingeblendet werden dürfen
            if (pageId !== 'page-home') {
              const tabContainer = document.querySelector('.tab-container');
              if (tabContainer) tabContainer.style.setProperty('display', 'flex', 'important');
            }

            // 5. URL in der Adresszeile ohne Neuladen anpassen
            const url = new URL(window.location.href);
            url.searchParams.set('page', pageId);
            window.history.replaceState({}, '', url);

            // 6. Dynamisches Update der Links für die Top-Seiten
            const tabLinks = document.querySelectorAll('.tab-container a');
            tabLinks.forEach(link => {
              try {
                const linkUrl = new URL(link.href, window.location.origin);
                linkUrl.searchParams.set('page', pageId);
                link.href = linkUrl.pathname + linkUrl.search;
              } catch(e) {
                console.error("Fehler beim Aktualisieren der Filter-Links:", e);
              }
            });
          }

          function formatTime(ms) {
            if (isNaN(ms) || ms < 0) return "0:00";
            const sec = Math.floor((ms / 1000) % 60);
            return Math.floor(ms / 60000) + ":" + (sec < 10 ? "0" : "") + sec;
          }

          async function sendControl(action) {
            try {
              const r = await fetch('/api/control/' + action);
              const data = await r.json();
              if (data.success === false && data.reason === 'premium_required') {
                premiumWarningUntil = Date.now() + 5000;
                const warn = document.getElementById('prem-warn');
                if (warn) warn.style.display = 'block';
              }
              setTimeout(updateStatus, 400);
            } catch(e) { console.error(e); }
          }

          async function handleSeek(e) {
            if (!localDuration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const percentage = clickX / rect.width;
            const targetMs = Math.floor(percentage * localDuration);
            localProgress = targetMs;
            
            const fill = document.getElementById('p-bar');
            if (fill) fill.style.width = (percentage * 100).toFixed(2) + '%';
            const time = document.getElementById('p-now');
            if (time) time.innerText = formatTime(targetMs);
            
            try { await fetch('/api/control/seek?position=' + targetMs); } catch(e){ console.error(e); }
          }

          async function updateStatus() {
            if (isFetchPending) return;
            isFetchPending = true;
            try {
              const res = await fetch('/api/now-playing');
              isFetchPending = false;
              if (!res || !res.ok) return;
              const data = await res.json();
              const container = document.getElementById('live-container');
              if (!container) return;

              if (data.title && data.image && data.image !== lastLoadedImage) {
                lastLoadedImage = data.image;
                const bg = document.getElementById('dynamic-bg');
                if (bg) bg.style.backgroundImage = "url('" + data.image + "')";
              }

              if (data.hasActiveSession) {
                isPlayingLive = data.isPlaying;
                localProgress = data.progressMs || 0;
                localDuration = data.durationMs || 0;

                const playIcon = isPlayingLive ? 'fa-pause' : 'fa-play';
                const waveHtml = isPlayingLive ? '<div class="wave-container"><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div></div>' : '';

                // SICHERER STRING OHNE SERVER-BACKTICKS
                container.innerHTML = 
                  '<div class="live-card">' +
                    '<img src="' + data.image + '" class="cover-art">' +
                    '<div class="info">' +
                      '<div class="label-wrapper">' +
                        '<span class="live-label">' + (isPlayingLive ? 'GERADE LÄUFT' : 'PAUSIERT') + '</span>' +
                        waveHtml +
                      '</div>' +
                      '<div class="track-name">' + data.title + '</div>' +
                      '<div class="artist-name">' + data.artist + '</div>' +
                      '<div class="premium-warning" id="prem-warn">⚠️ Spotify Premium für Steuerung benötigt!</div>' +
                      '<div class="controls">' +
                        '<button class="ctrl-btn" id="btn-spotify-prev"><i class="fas fa-backward-step"></i></button>' +
                        '<button class="ctrl-btn play" id="btn-spotify-toggle"><i class="fas ' + playIcon + '"></i></button>' +
                        '<button class="ctrl-btn" id="btn-spotify-next"><i class="fas fa-forward-step"></i></button>' +
                      '</div>' +
                      '<div class="progress-area">' +
                        '<span id="p-now">' + formatTime(localProgress) + '</span>' +
                        '<div class="bar-bg" onclick="handleSeek(event)">' +
                          '<div class="bar-fill" id="p-bar" style="width: ' + ((localProgress/localDuration)*100).toFixed(2) + '%;"></div>' +
                        '</div>' +
                        '<span>' + formatTime(localDuration) + '</span>' +
                      '</div>' +
                    '</div>' +
                  '</div>';

                // Event-Listener sauber per JS-Code binden
                const pBtn = document.getElementById('btn-spotify-prev');
                const tBtn = document.getElementById('btn-spotify-toggle');
                const nBtn = document.getElementById('btn-spotify-next');
                
                if (pBtn) pBtn.onclick = function() { sendControl('prev'); };
                if (tBtn) tBtn.onclick = function() { sendControl('toggle'); };
                if (nBtn) nBtn.onclick = function() { sendControl('next'); };

              } else {
                isPlayingLive = false;
                container.innerHTML = 
                  '<div class="live-card">' +
                    '<p style="margin:0;color:#b3b3b3;">Zuletzt gehört:</p>' +
                    '<img src="' + (data.image || 'https://via.placeholder.com/150') + '" width="60" style="border-radius:8px; margin: 0 15px;">' +
                    '<div>' +
                      '<strong style="display:block;">' + (data.title || 'Keine aktive Wiedergabe') + '</strong>' +
                      '<span style="color:#b3b3b3; font-size:14px;">' + (data.artist || '') + '</span>' +
                    '</div>' +
                  '</div>';
              }
            } catch (e) {
              isFetchPending = false;
              console.error(e);
            }
          }

          // Quiz Engine
          let quizScore = 0;
          let quizHighScore = localStorage.getItem('quizHighScore') ? parseInt(localStorage.getItem('quizHighScore')) : 0;
          let yearHighScore = localStorage.getItem('yearHighScore') ? parseInt(localStorage.getItem('yearHighScore')) : 0;

          function startSongQuiz() {
            if (typeof quizPool !== 'undefined' && quizPool.length < 4) {
              document.getElementById('game-arena').innerHTML = '<p style="text-align:center;color:#ff5252;">Nicht genug Songs für ein Quiz vorhanden.</p>';
              return;
            }
            quizScore = 0;

            // ERGÄNZUNG: Setzt die "..." oben links sofort beim Klick auf "Song-Quiz starten" auf 0
            const topScoreEl = document.getElementById('quiz-live-score') || document.getElementById('live-score');
            if (topScoreEl) {
              topScoreEl.innerText = '0';
            }

            nextQuizQuestion();
          }

          function nextQuizQuestion() {
            let aktuelleTracks = [];
            try {
              if (typeof quizPool !== 'undefined' && quizPool && quizPool.length > 0) {
                aktuelleTracks = quizPool;
              } else if (typeof base64QuizPool !== 'undefined') {
                aktuelleTracks = JSON.parse(decodeURIComponent(atob(base64QuizPool)));
              } else if (typeof tracks !== 'undefined' && tracks) {
                aktuelleTracks = tracks;
              } else if (typeof topTracks !== 'undefined' && topTracks) {
                aktuelleTracks = topTracks;
              }
            } catch (e) {
              console.error("Fehler beim Entpacken:", e);
            }

            if (!aktuelleTracks || aktuelleTracks.length < 4) {
              const arena = document.getElementById('game-arena');
              if (arena) arena.innerHTML = '<p style="color:#b3b3b3;text-align:center;">Lade Spieldaten...</p>';
              return;
            }

            // Zufälliges Mischen der Tracks
            let shuffled = [...aktuelleTracks].sort(() => 0.5 - Math.random());
            
            // Wir nehmen die ganzen Track-Objekte für die Optionen, nicht nur die Titel
            let options = shuffled.slice(0, 4); 
            let correctTrack = options[0]; // Der erste ist der richtige

            // Die Optionen noch einmal mischen, damit die richtige Antwort nicht immer auf Button 1 liegt
            options = [...options].sort(() => 0.5 - Math.random());

            const arena = document.getElementById('game-arena');
            if (arena) {
              arena.innerHTML = '';

              const card = document.createElement('div');
              card.className = 'quiz-card';

              const scoreDiv = document.createElement('div');
              scoreDiv.className = 'quiz-score';
              scoreDiv.style.display = 'block';
              scoreDiv.style.margin = '0 auto 20px auto';
              scoreDiv.style.width = 'max-content';
              scoreDiv.style.textAlign = 'center';
              scoreDiv.innerHTML = 'Score: ' + quizScore + ' <span style="color:#b3b3b3; margin-left: 15px; font-size: 13px;">Highscore: ' + quizHighScore + '</span>';

              // Falls ein Image-Feld fehlt, Backup-Bild nutzen
              const trackImage = correctTrack.image || correctTrack.cover || 'https://via.placeholder.com/150';

              const imgWrapper = document.createElement('div');
              imgWrapper.className = 'quiz-img-wrapper';
              const img = document.createElement('img');
              img.src = trackImage;
              img.className = 'quiz-img';
              imgWrapper.appendChild(img);

              const questionHeading = document.createElement('h3');
              questionHeading.style.margin = '20px 0 10px 0';
              questionHeading.innerText = 'Von welchem Song stammt dieses Album-Cover?';

              const trackArtist = correctTrack.artist || correctTrack.artistName || 'Unbekannter Künstler';
              const artistP = document.createElement('p');
              artistP.style.color = '#b3b3b3';
              artistP.style.marginBottom = '20px';
              artistP.innerText = 'Künstler: ' + trackArtist;

              const optionsDiv = document.createElement('div');
              optionsDiv.className = 'quiz-options';

              options.forEach(opt => {
                const btn = document.createElement('button');
                btn.className = 'quiz-btn';
                
                // FEHLER-BEHEBUNG: Schaut nach '.title' ODER '.name', falls Daten variieren
                const songTitle = opt.title || opt.name || 'Unbekannter Song';
                const correctTitle = correctTrack.title || correctTrack.name || 'Unbekannter Song';
                
                // Wir speichern den echten Titel im data-Attribut ab!
                btn.setAttribute('data-name', songTitle);
                
                btn.innerHTML = 
                  '<div class="quiz-btn-info" style="width:100%; text-align:center;">' +
                    '<div class="card-title" style="font-weight:600; font-size:14px;">' + songTitle + '</div>' +
                  '</div>';
                
                btn.onclick = function() {
                  checkQuizAnswer(
                    btoa(encodeURIComponent(songTitle)), 
                    btoa(encodeURIComponent(correctTitle))
                  );
                };
                optionsDiv.appendChild(btn);
              });

              card.appendChild(scoreDiv);
              card.appendChild(imgWrapper);
              card.appendChild(questionHeading);
              card.appendChild(artistP);
              card.appendChild(optionsDiv);
              arena.appendChild(card);
            }
          }

          function checkQuizAnswer(selectedB64, correctB64) {
            const selected = decodeURIComponent(atob(selectedB64));
            const correct = decodeURIComponent(atob(correctB64));
            const buttons = document.querySelectorAll('.quiz-options .quiz-btn');
            
            buttons.forEach(btn => {
              btn.disabled = true;
              btn.style.cursor = 'default';
              const btnName = btn.getAttribute('data-name');
              
              if (btnName === correct) {
                btn.style.setProperty('background', 'rgba(29, 185, 84, 0.2)', 'important');
                btn.style.setProperty('border-color', '#1DB954', 'important');
                btn.style.setProperty('color', '#fff', 'important');
              } else if (btnName === selected && selected !== correct) {
                btn.style.setProperty('background', 'rgba(255, 82, 82, 0.2)', 'important');
                btn.style.setProperty('border-color', '#ff5252', 'important');
                btn.style.setProperty('color', '#fff', 'important');
              }
            });

            if (selected === correct) {
              quizScore++;
              
              // 1. Aktualisiert die Anzeige direkt auf der Quiz-Karte
              const scoreDiv = document.querySelector('.quiz-score');
              if (scoreDiv) {
                scoreDiv.innerHTML = 'Score: ' + quizScore + ' <span style="color:#b3b3b3; margin-left: 15px; font-size: 13px;">Highscore: ' + quizHighScore + '</span>';
              }

              // 2. LIVE-FIX FÜR DIE ANZEIGE OBEN LINKS:
              // Aktualisiert das Element mit der ID, in dem die drei Punkte festsitzen
              const topScoreEl = document.getElementById('quiz-live-score') || document.getElementById('live-score');
              if (topScoreEl) {
                topScoreEl.innerText = quizScore;
              }

              // Falls es im Dashboard als normales h2/h3 Span gewrapped ist:
              const allSpans = document.querySelectorAll('h2 span, h3 span');
              allSpans.forEach(span => {
                if (span.innerText === '...' || span.textContent.includes('...')) {
                  span.innerText = quizScore;
                }
              });

              // Lädt die nächste Frage nach 1,5 Sekunden
              setTimeout(nextQuizQuestion, 1500);
            } else {
              if (quizScore > quizHighScore) {
                quizHighScore = quizScore;
                localStorage.setItem('quizHighScore', quizHighScore);
              }

              // Game Over Screen einblenden
              setTimeout(() => {
                const arena = document.getElementById('game-arena');
                if (arena) {
                  arena.innerHTML = '';
                  
                  const card = document.createElement('div');
                  card.className = 'quiz-card';
                  card.style.borderColor = '#ff5252';
                  
                  const title = document.createElement('h2');
                  title.innerText = 'Falsch geraten! ❌';
                  
                  const scoreP = document.createElement('p');
                  scoreP.style.fontSize = '18px';
                  scoreP.style.margin = '15px 0';
                  scoreP.innerHTML = 'Deine Punktzahl: <strong style="color:#1DB954;">' + quizScore + '</strong><br><span style="font-size:14px; color:#b3b3b3;">Dein Highscore: ' + quizHighScore + '</span>';
                  
                  const correctP = document.createElement('p');
                  correctP.style.color = '#b3b3b3';
                  correctP.style.marginBottom = '20px';
                  correctP.innerHTML = 'Richtige Antwort war: <strong>' + correct + '</strong>';
                  
                  const btn = document.createElement('button');
                  btn.className = 'hl-btn'; 
                  btn.innerText = 'Nochmal spielen';
                  btn.onclick = startSongQuiz;
                  
                  card.appendChild(title);
                  card.appendChild(scoreP);
                  card.appendChild(correctP);
                  card.appendChild(btn);
                  arena.appendChild(card);
                }
              }, 1700);
            }
          }

          // Release-Jahr-Quiz
          let yearScore = 0;
          let yearSliderMin = 1990;
          let yearSliderMax = new Date().getFullYear();

          function startYearQuiz() {
            if (typeof yearPool === 'undefined' || yearPool.length < 1) {
              document.getElementById('game-arena').innerHTML = '<p style="text-align:center;color:#ff5252;">Nicht genug Songs mit Erscheinungsjahr vorhanden.</p>';
              return;
            }

            // Slider-Bereich anhand der echten Top-Tracks bestimmen (mit etwas Puffer)
            const years = yearPool.map(t => t.year);
            const currentYear = new Date().getFullYear();
            yearSliderMin = Math.max(1950, Math.min.apply(null, years) - 5);
            yearSliderMax = Math.min(currentYear, Math.max.apply(null, years) + 5);
            if (yearSliderMax - yearSliderMin < 10) {
              yearSliderMin = Math.max(1950, yearSliderMin - 5);
              yearSliderMax = Math.min(currentYear, yearSliderMax + 5);
            }

            yearScore = 0;
            nextYearQuestion();
          }

          function nextYearQuestion() {
            const idx = Math.floor(Math.random() * yearPool.length);
            const track = yearPool[idx];
            const startValue = Math.round((yearSliderMin + yearSliderMax) / 2);

            document.getElementById('game-arena').innerHTML = \`
              <div class="quiz-card">
                <div class="quiz-score">Score: \${yearScore} <span style="color:#b3b3b3; margin-left: 15px; font-size: 13px;">Highscore: \${yearHighScore}</span></div>
                <h2>In welchem Jahr wurde dieser Song veröffentlicht?</h2>
                <div class="quiz-img-wrapper">
                  <img src="\${track.image}" class="quiz-img">
                </div>
                <h3 style="margin-bottom:2px;">\${track.title}</h3>
                <p style="color:#b3b3b3; margin-top:0;">\${track.artist}</p>

                <div class="year-slider-wrapper">
                  <div class="year-display" id="year-display">\${startValue}</div>
                  <input type="range" min="\${yearSliderMin}" max="\${yearSliderMax}" step="1" value="\${startValue}" class="year-slider" id="year-slider" oninput="document.getElementById('year-display').innerText = this.value">
                  <div class="year-slider-labels">
                    <span>\${yearSliderMin}</span>
                    <span>\${yearSliderMax}</span>
                  </div>
                </div>

                <button class="hl-btn" id="year-confirm-btn" onclick="checkYearAnswer(\${track.year})">Bestätigen</button>
              </div>\`;
          }

          function checkYearAnswer(actualYear) {
            const slider = document.getElementById('year-slider');
            const guess = parseInt(slider.value, 10);
            const diff = Math.abs(guess - actualYear);
            const correct = diff <= 2; // 2 Jahre Toleranz

            slider.disabled = true;
            const confirmBtn = document.getElementById('year-confirm-btn');
            if (confirmBtn) confirmBtn.style.display = 'none';

            const resultP = document.createElement('p');
            resultP.style.fontWeight = '700';
            resultP.style.fontSize = '18px';
            resultP.style.marginTop = '15px';

            if (correct) {
              resultP.style.color = '#1DB954';
              resultP.innerHTML = (diff === 0)
                ? 'Genau richtig! ' + actualYear + ' ✔'
                : 'Nah dran! Tatsächlich: ' + actualYear + ' ✔';
            } else {
              resultP.style.color = '#ff5252';
              resultP.innerHTML = 'Leider falsch. Tatsächlich: ' + actualYear + ' ❌';
            }

            const card = document.querySelector('.quiz-card');
            if (card) card.appendChild(resultP);

            if (correct) {
              yearScore++;

              const scoreDiv = document.querySelector('.quiz-score');
              if (scoreDiv) {
                scoreDiv.innerHTML = 'Score: ' + yearScore + ' <span style="color:#b3b3b3; margin-left: 15px; font-size: 13px;">Highscore: ' + yearHighScore + '</span>';
              }

              setTimeout(nextYearQuestion, 1800);
            } else {
              if (yearScore > yearHighScore) {
                yearHighScore = yearScore;
                localStorage.setItem('yearHighScore', yearHighScore);
              }

              setTimeout(() => {
                const arena = document.getElementById('game-arena');
                if (arena) {
                  arena.innerHTML = '';

                  const card = document.createElement('div');
                  card.className = 'quiz-card';
                  card.style.borderColor = '#ff5252';

                  const title = document.createElement('h2');
                  title.innerText = 'Vorbei! ❌';

                  const scoreP = document.createElement('p');
                  scoreP.style.fontSize = '18px';
                  scoreP.style.margin = '15px 0';
                  scoreP.innerHTML = 'Deine Punktzahl: <strong style="color:#1DB954;">' + yearScore + '</strong><br><span style="font-size:14px; color:#b3b3b3;">Dein Highscore: ' + yearHighScore + '</span>';

                  const btn = document.createElement('button');
                  btn.className = 'hl-btn';
                  btn.innerText = 'Nochmal spielen';
                  btn.onclick = startYearQuiz;

                  card.appendChild(title);
                  card.appendChild(scoreP);
                  card.appendChild(btn);
                  arena.appendChild(card);
                }
              }, 2200);
            }
          }

          setInterval(() => {
            if (Date.now() >= premiumWarningUntil) {
              const w = document.getElementById('prem-warn');
              if (w) w.style.display = 'none';
            }
          }, 500);

          setInterval(() => {
            if (!isPlayingLive || localProgress >= localDuration) return;
            localProgress += 1000;
            const bar  = document.getElementById('p-bar');
            const time = document.getElementById('p-now');
            if (bar)  bar.style.width  = (localProgress / localDuration * 100).toFixed(2) + '%';
            if (time) time.innerText   = formatTime(localProgress);
          }, 1000);

          function toggleView() {
            const body = document.body;
            const btn = document.getElementById('view-toggle-btn');
            
            if (!body || !btn) return;

            if (body.classList.contains('mobile-mode')) {
              body.classList.remove('mobile-mode');
              btn.innerHTML = '<i class="fas fa-mobile-alt"></i> Handy-Ansicht';
              localStorage.setItem('preferredView', 'desktop');
            } else {
              body.classList.add('mobile-mode');
              btn.innerHTML = '<i class="fas fa-desktop"></i> Desktop-Ansicht';
              localStorage.setItem('preferredView', 'mobile');
            }
          }

          // ─── 2. BEIM LADEN DER SEITE AUSFÜHREN ─────────────────────────────
          window.addEventListener('DOMContentLoaded', () => {
            const toggleBtn = document.getElementById('view-toggle-btn');
            if (toggleBtn) {
              toggleBtn.addEventListener('click', toggleView);
            }

            // Holt die aktuelle Seite aus der Server-Variable und rendert sie verzögert nach 50ms
            const initialPage = "${currentPage}" || "page-home";
            setTimeout(() => {
              switchPage(initialPage);
            }, 50);
            
            updateStatus();
            setInterval(updateStatus, 5000);

            const savedView = localStorage.getItem('preferredView');
            if (savedView === 'mobile') {
              document.body.classList.add('mobile-mode');
              if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-desktop"></i> Desktop-Ansicht';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.send('Fehler beim Laden der Seite: ' + (err.message || 'Unbekannter Fehler'));
  }
});

app.listen(port, () => console.log(`Server läuft auf http://127.0.0.1:${port}`));