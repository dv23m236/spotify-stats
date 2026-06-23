require('dotenv').config(); // Lädt Variablen aus der .env-Datei (lokal) bzw. aus den Azure App Settings

const Express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const { CosmosClient } = require('@azure/cosmos');
const session = require('express-session');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

app.set('trust proxy', 1);

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

async function resolveSpotifyUserId(req, userApi) {
  if (req.session && req.session.spotifyUserId) {
    return req.session.spotifyUserId;
  }
  const api = userApi || getUserSpotifyApi(req);
  const me = await api.getMe();
  const userId = me?.body?.id || null;
  if (userId && req.session) {
    req.session.spotifyUserId = userId;
  }
  return userId;
}

async function readUserHighscoreDoc(userId) {
  if (!usersContainer || !userId) return null;
  try {
    const result = await usersContainer.item(userId, userId).read();
    return result?.resource || null;
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === 404) return null;
    throw err;
  }
}

async function upsertUserHighscoreDoc(userId, currentDoc, nextValues) {
  if (!usersContainer || !userId) return null;
  const doc = {
    id: userId,
    userId,
    quizHighscore: Number(nextValues.quizHighscore ?? currentDoc?.quizHighscore ?? 0) || 0,
    sliderHighscore: Number(nextValues.sliderHighscore ?? currentDoc?.sliderHighscore ?? 0) || 0,
    updatedAt: new Date().toISOString()
  };
  const payload = currentDoc ? { ...currentDoc, ...doc } : doc;
  const result = await usersContainer.items.upsert(payload);
  return result?.resource || payload;
}

// ─── AZURE COSMOS DB CONFIG ──────────────────────────────────────────────────
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
let cosmosContainer = null;
let usersContainer = null;
let streamHistoryContainer = null;

if (cosmosEndpoint && cosmosKey) {
  const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });
  async function initCosmos() {
    try {
      const { database } = await client.databases.createIfNotExists({ id: 'SpotifyStats' });
      const { container } = await database.containers.createIfNotExists({
        id: 'HistoricalStats',
        partitionKey: { paths: ['/partitionKey'] }
      });
      const { container: userContainer } = await database.containers.createIfNotExists({
        id: 'Users',
        partitionKey: { paths: ['/userId'] }
      });
      const { container: streamContainer } = await database.containers.createIfNotExists({
        id: 'StreamHistory',
        partitionKey: { paths: ['/userId'] }
      });
      cosmosContainer = container;
      usersContainer = userContainer;
      streamHistoryContainer = streamContainer;
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

// ─── BACKGROUND LIVE-TRACKING (4H INTERVALL) ─────────────────────────────────
// Token-Registry: userId -> { accessToken, refreshToken, tokenExpires }
// Wird beim Login befüllt und beim Token-Refresh aktualisiert.
// Kein Zugriff auf den Session-Store – kein Konflikt mit dem Login-Flow.
const tokenRegistry = new Map();

const STREAM_SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
let streamSyncIsRunning = false;

async function syncStreamHistoryForUser(userId, entry) {
  const userApi = new SpotifyWebApi(spotifyCredentials);
  userApi.setAccessToken(entry.accessToken);
  userApi.setRefreshToken(entry.refreshToken);

  // Token erneuern, falls er in weniger als 2 Minuten abläuft
  if (entry.tokenExpires && Date.now() > entry.tokenExpires - 120000) {
    if (!entry.refreshToken) throw new Error('Kein Refresh-Token für User ' + userId);
    const refreshed = await userApi.refreshAccessToken();
    entry.accessToken = refreshed.body['access_token'];
    entry.tokenExpires = Date.now() + (refreshed.body['expires_in'] * 1000);
    userApi.setAccessToken(entry.accessToken);
    tokenRegistry.set(userId, entry);
  }

  let recent;
  try {
    recent = await userApi.getMyRecentlyPlayedTracks({ limit: 50 });
  } catch (err) {
    const unauthorized = err?.statusCode === 401 || String(err?.message || '').includes('The access token expired');
    if (!unauthorized || !entry.refreshToken) throw err;
    // Einmaliger Retry nach Token-Refresh
    const refreshed = await userApi.refreshAccessToken();
    entry.accessToken = refreshed.body['access_token'];
    entry.tokenExpires = Date.now() + (refreshed.body['expires_in'] * 1000);
    userApi.setAccessToken(entry.accessToken);
    tokenRegistry.set(userId, entry);
    recent = await userApi.getMyRecentlyPlayedTracks({ limit: 50 });
  }

  const items = recent?.body?.items || [];
  if (items.length === 0) return;

  const candidatePlayedAt = items.map(i => i.played_at).filter(Boolean);
  if (candidatePlayedAt.length === 0) return;

  const { resources: existingRows } = await streamHistoryContainer.items.query({
    query: 'SELECT c.playedAt FROM c WHERE c.userId = @userId AND ARRAY_CONTAINS(@playedAtList, c.playedAt)',
    parameters: [
      { name: '@userId', value: userId },
      { name: '@playedAtList', value: candidatePlayedAt }
    ]
  }).fetchAll();

  const knownPlayedAt = new Set((existingRows || []).map(r => r.playedAt));
  const newStreams = items.filter(i => i.played_at && !knownPlayedAt.has(i.played_at));

  for (const item of newStreams) {
    const track = item.track || {};
    const playedAt = item.played_at;
    const safePlayedAt = String(playedAt).replace(/[:.]/g, '-');
    const trackId = track.id || 'unknown-track';
    await streamHistoryContainer.items.upsert({
      id: `${userId}_${safePlayedAt}_${trackId}`,
      userId,
      playedAt,
      trackId,
      title: track.name || 'Unbekannt',
      artist: track.artists && track.artists[0] ? track.artists[0].name : 'Unbekannt',
      album: track.album ? track.album.name : null,
      image: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
      durationMs: track.duration_ms || null,
      syncedAt: new Date().toISOString()
    });
  }

  if (newStreams.length > 0) {
    console.log(`--- [Cron] User ${userId}: ${newStreams.length} neue Streams gespeichert ---`);
  }
}

async function runStreamHistorySyncJob() {
  if (streamSyncIsRunning) {
    console.log('--- [Cron] StreamHistory-Sync übersprungen: Job läuft bereits ---');
    return;
  }
  if (!streamHistoryContainer) {
    console.log('--- [Cron] StreamHistory-Sync übersprungen: Cosmos DB nicht verbunden (lokaler Modus oder fehlende Env-Variablen) ---');
    return;
  }
  if (tokenRegistry.size === 0) {
    console.log('--- [Cron] StreamHistory-Sync übersprungen: Keine eingeloggten User in der Registry ---');
    return;
  }

  streamSyncIsRunning = true;
  try {
    for (const [userId, entry] of tokenRegistry.entries()) {
      try {
        await syncStreamHistoryForUser(userId, entry);
      } catch (err) {
        console.error(`--- [Cron] Fehler für User ${userId}:`, err?.message || err);
      }
    }
  } finally {
    streamSyncIsRunning = false;
  }
}

setInterval(runStreamHistorySyncJob, STREAM_SYNC_INTERVAL_MS);

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
    .then(async data => {
      req.session.accessToken = data.body['access_token'];
      req.session.refreshToken = data.body['refresh_token'];
      req.session.tokenExpires = Date.now() + (data.body['expires_in'] * 1000);

      // User-ID für den Hintergrund-Cron-Job ermitteln und in der Registry registrieren
      try {
        const tmpApi = new SpotifyWebApi(spotifyCredentials);
        tmpApi.setAccessToken(req.session.accessToken);
        const me = await tmpApi.getMe();
        const userId = me?.body?.id;
        if (userId) {
          req.session.spotifyUserId = userId;
          tokenRegistry.set(userId, {
            accessToken: req.session.accessToken,
            refreshToken: req.session.refreshToken,
            tokenExpires: req.session.tokenExpires
          });
        }
      } catch (regErr) {
        console.error('--- [System] Token-Registry-Eintrag fehlgeschlagen:', regErr.message);
      }

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

// Monatsauswertung: Top-Tracks aggregiert aus StreamHistory (mit lokalem Mock-Fallback)
app.get('/api/stats/month', checkAndRefreshUserToken, async (req, res) => {
  const month = String(req.query.month || '').trim();
  const monthMatch = month.match(/^(\d{4})-(\d{2})$/);
  if (!monthMatch) {
    return res.status(400).json({ error: 'Ungültiger Monat. Erwartet wird YYYY-MM.' });
  }

  const year = parseInt(monthMatch[1], 10);
  const monthIndex = parseInt(monthMatch[2], 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    return res.status(400).json({ error: 'Ungültiger Monat.' });
  }

  const monthStart = new Date(Date.UTC(year, monthIndex, 1));
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 1));
  const startIso = monthStart.toISOString();
  const endIso = monthEnd.toISOString();

  // Lokal-Schutz: Ohne Cosmos liefern wir Mock-Daten für Frontend-Tests.
  if (!streamHistoryContainer) {
    return res.status(200).json({
      source: 'mock',
      month,
      tracks: [
        {
          rank: 1,
          trackId: 'mock-track-1',
          title: 'Midnight Pulse',
          artist: 'Neon Harbor',
          image: 'https://via.placeholder.com/150',
          playCount: 42
        },
        {
          rank: 2,
          trackId: 'mock-track-2',
          title: 'Static Hearts',
          artist: 'Luma Drift',
          image: 'https://via.placeholder.com/150',
          playCount: 31
        },
        {
          rank: 3,
          trackId: 'mock-track-3',
          title: 'Echo Avenue',
          artist: 'Atlas Bloom',
          image: 'https://via.placeholder.com/150',
          playCount: 24
        }
      ]
    });
  }

  try {
    const userId = await resolveSpotifyUserId(req, userApi);

    if (!userId) {
      return res.status(400).json({ error: 'Spotify-User konnte nicht ermittelt werden.' });
    }

    const { resources } = await streamHistoryContainer.items.query({
      query:
        'SELECT c.trackId, c.title, c.artist, c.image, COUNT(1) AS playCount ' +
        'FROM c ' +
        'WHERE c.userId = @userId ' +
        'AND c.playedAt >= @startIso ' +
        'AND c.playedAt < @endIso ' +
        'GROUP BY c.trackId, c.title, c.artist, c.image',
      parameters: [
        { name: '@userId', value: userId },
        { name: '@startIso', value: startIso },
        { name: '@endIso', value: endIso }
      ]
    }).fetchAll();

    const tracks = (resources || [])
      .map(r => ({
        trackId: r.trackId || null,
        title: r.title || 'Unbekannt',
        artist: r.artist || 'Unbekannt',
        image: r.image || 'https://via.placeholder.com/150',
        playCount: Number(r.playCount || 0)
      }))
      .sort((a, b) => b.playCount - a.playCount)
      .map((t, idx) => ({ ...t, rank: idx + 1 }));

    return res.status(200).json({ source: 'cosmos', month, tracks });
  } catch (err) {
    console.error('--- [API] /api/stats/month Fehler:', err?.message || err);
    return res.status(500).json({ error: 'Monatsauswertung konnte nicht geladen werden.' });
  }
});

// ─── HIGHSCORES (Cosmos DB + lokaler Session-Fallback) ──────────────────────
app.get('/api/highscores/me', checkAndRefreshUserToken, async (req, res) => {
  const sessionFallback = req.session.highscores || {};

  if (!usersContainer) {
    return res.json({
      quizHighscore: Number(sessionFallback.quiz) || 0,
      sliderHighscore: Number(sessionFallback.slider) || 0
    });
  }

  try {
    const userId = await resolveSpotifyUserId(req);
    if (!userId) {
      return res.json({
        quizHighscore: Number(sessionFallback.quiz) || 0,
        sliderHighscore: Number(sessionFallback.slider) || 0
      });
    }

    const doc = await readUserHighscoreDoc(userId);
    if (doc) {
      return res.json({
        quizHighscore: Number(doc.quizHighscore) || 0,
        sliderHighscore: Number(doc.sliderHighscore) || 0
      });
    }

    return res.json({
      quizHighscore: Number(sessionFallback.quiz) || 0,
      sliderHighscore: Number(sessionFallback.slider) || 0
    });
  } catch (err) {
    console.error('--- [API] /api/highscores/me Fehler:', err?.message || err);
    return res.json({
      quizHighscore: Number(sessionFallback.quiz) || 0,
      sliderHighscore: Number(sessionFallback.slider) || 0
    });
  }
});

app.post('/api/highscores', checkAndRefreshUserToken, Express.json(), async (req, res) => {
  const { game, score } = req.body || {};
  const validGames = ['quiz', 'slider'];
  if (!validGames.includes(game)) {
    return res.status(400).json({ error: 'Ungültiges game. Erlaubt: quiz, slider.' });
  }

  const scoreInt = Math.max(0, Math.floor(Number(score) || 0));
  if (!req.session.highscores) req.session.highscores = { quiz: 0, slider: 0 };

  if (!usersContainer) {
    if (scoreInt > (Number(req.session.highscores[game]) || 0)) {
      req.session.highscores[game] = scoreInt;
    }
    return res.json({
      quizHighscore: Number(req.session.highscores.quiz) || 0,
      sliderHighscore: Number(req.session.highscores.slider) || 0
    });
  }

  try {
    const userId = await resolveSpotifyUserId(req);
    if (!userId) {
      if (scoreInt > (Number(req.session.highscores[game]) || 0)) {
        req.session.highscores[game] = scoreInt;
      }
      return res.json({
        quizHighscore: Number(req.session.highscores.quiz) || 0,
        sliderHighscore: Number(req.session.highscores.slider) || 0
      });
    }

    const currentDoc = await readUserHighscoreDoc(userId);
    const nextDoc = {
      quizHighscore: Math.max(Number(currentDoc?.quizHighscore) || 0, game === 'quiz' ? scoreInt : 0),
      sliderHighscore: Math.max(Number(currentDoc?.sliderHighscore) || 0, game === 'slider' ? scoreInt : 0)
    };
    const savedDoc = await upsertUserHighscoreDoc(userId, currentDoc, nextDoc);

    return res.json({
      quizHighscore: Number(savedDoc?.quizHighscore) || 0,
      sliderHighscore: Number(savedDoc?.sliderHighscore) || 0
    });
  } catch (err) {
    console.error('--- [API] /api/highscores Fehler:', err?.message || err);
    if (scoreInt > (Number(req.session.highscores[game]) || 0)) {
      req.session.highscores[game] = scoreInt;
    }
    return res.json({
      quizHighscore: Number(req.session.highscores.quiz) || 0,
      sliderHighscore: Number(req.session.highscores.slider) || 0
    });
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
    const currentTracksData = tracksArray.map(t => ({
      title: t.name,
      artist: t.artists && t.artists[0] ? t.artists[0].name : 'Künstler',
      image: t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : 'https://via.placeholder.com/150'
    }));
    const currentArtistsData = artistsArray.map(a => ({
      name: a.name,
      genre: a.genres && a.genres[0] ? a.genres[0] : 'Künstler',
      image: a.images && a.images[0] ? a.images[0].url : 'https://via.placeholder.com/150'
    }));
    const base64CurrentTracks = Buffer.from(encodeURIComponent(JSON.stringify(currentTracksData))).toString('base64');
    const base64CurrentArtists = Buffer.from(encodeURIComponent(JSON.stringify(currentArtistsData))).toString('base64');

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
          .section-header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:30px; margin-bottom:14px; }
          .section-header .section-title { margin:0; }
          .month-selector-wrap { display:flex; align-items:center; gap:8px; }
          .month-selector-label { font-size:12px; font-weight:600; color:#b3b3b3; letter-spacing:0.3px; }
          .month-selector {
            background:rgba(255,255,255,0.06);
            color:#fff;
            border:1px solid rgba(255,255,255,0.12);
            border-radius:999px;
            padding:7px 12px;
            font-family:'Poppins',sans-serif;
            font-size:12px;
            font-weight:600;
            outline:none;
            cursor:pointer;
          }
          .month-selector:focus { border-color:#1DB954; box-shadow:0 0 0 2px rgba(29,185,84,0.2); }
          .month-status { color:#b3b3b3; font-size:12px; margin-bottom:12px; min-height:18px; }
          .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:25px; margin-bottom:40px; }
          .card { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.04); padding:18px; border-radius:16px; transition:all 0.3s cubic-bezier(0.4,0,0.2,1); text-align:center; position:relative; }
          .card:hover { background:rgba(255,255,255,0.06); border-color:rgba(255,255,255,0.1); transform:translateY(-5px); }
          .card img { width:100%; aspect-ratio:1; border-radius:10px; object-fit:cover; margin-bottom:14px; box-shadow:0 8px 20px rgba(0,0,0,0.4); }
          .rank { position:absolute; top:10px; left:10px; background:#1DB954; color:black; font-weight:700; padding:2px 10px; border-radius:20px; font-size:11px; }
          .card-meta { min-width:0; width:100%; }
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

          .mobile-bottom-nav { display:none; }

          /* ==========================================
             RESPONSIVE DESIGN – LIST MODE MOBILE
             ========================================== */
          @media (max-width: 768px) {
            body { flex-direction:column; display:flex; background:#0c0c0c; }
            .sidebar { display:none !important; }
            .main-content { margin-left:0 !important; padding:0.6rem 0.5rem 5.3rem !important; width:100% !important; }
            .section-title { margin-top:0.7rem !important; margin-bottom:0.45rem !important; font-size:1rem !important; }
            .section-header { margin-top:0.5rem !important; margin-bottom:0.4rem !important; gap:0.4rem !important; }
            .month-selector-wrap { width:100% !important; justify-content:flex-start !important; }
            .month-selector-label { font-size:0.72rem !important; }
            .month-selector { width:100% !important; border-radius:0.5rem !important; padding:0.38rem 0.48rem !important; font-size:0.74rem !important; }
            .month-status { font-size:0.72rem !important; margin-bottom:0.4rem !important; }
            .filter-bar { flex-direction:column !important; gap:0.35rem !important; align-items:stretch !important; width:100% !important; margin-bottom:0.5rem !important; max-width:30rem !important; margin-left:auto !important; margin-right:auto !important; }
            .tab-container { width:100% !important; display:flex !important; justify-content:space-between !important; padding:0.15rem !important; gap:0.2rem !important; }
            .tab-btn { flex:1 !important; text-align:center !important; padding:0.35rem 0.15rem !important; font-size:0.7rem !important; }
            .filter-bar > div:last-child { display:flex !important; width:100% !important; gap:0.35rem !important; }
            #dropdown-limit, #dropdown-recent { flex:1 !important; justify-content:space-between !important; background:rgba(255,255,255,0.03) !important; padding:0.3rem 0.45rem !important; border-radius:0.5rem !important; border:1px solid rgba(255,255,255,0.05) !important; }
            select { background:transparent !important; border:none !important; padding:0 !important; font-size:0.72rem !important; }
            #live-container, .recent-list, .grid { max-width:32rem !important; margin-left:auto !important; margin-right:auto !important; }
            .live-card { flex-direction:row !important; align-items:center !important; text-align:left !important; padding:0.5rem !important; gap:0.5rem !important; border-radius:0.6rem !important; }
            .cover-art { width:3.4rem !important; height:3.4rem !important; border-radius:0.35rem !important; }
            .track-name { font-size:0.9rem !important; line-height:1.2 !important; margin:0.1rem 0 !important; }
            .artist-name { font-size:0.78rem !important; margin-bottom:0.2rem !important; }
            .controls { gap:0.55rem !important; margin-bottom:0.25rem !important; }
            .ctrl-btn { font-size:0.9rem !important; }
            .ctrl-btn.play { font-size:1.35rem !important; }
            .higher-lower-grid { grid-template-columns:1fr !important; gap:0.55rem !important; }
            .recent-list { display:flex !important; flex-direction:column !important; gap:0.35rem !important; padding:0 !important; }
            .recent-item { flex-direction:row !important; align-items:center !important; background:rgba(255,255,255,0.03) !important; padding:0.35rem 0.45rem !important; border-radius:0.5rem !important; gap:0.5rem !important; }
            .recent-item img { width:2.2rem !important; height:2.2rem !important; border-radius:0.35rem !important; }
            .recent-title { font-size:0.8rem !important; font-weight:600 !important; margin-bottom:0.05rem !important; }
            .recent-artist { font-size:0.72rem !important; color:#b3b3b3 !important; }
            /* Vertikale Listenzeilen */
            .grid { display:flex !important; flex-direction:column !important; gap:0.35rem !important; margin-bottom:0.65rem !important; }
            .card { width:100% !important; max-width:32rem !important; margin:0 auto !important; display:flex !important; flex-direction:row !important; align-items:center !important; padding:0.35rem 0.45rem !important; border-radius:0.6rem !important; gap:0.45rem !important; background:rgba(255,255,255,0.05) !important; text-align:left !important; border:1px solid rgba(255,255,255,0.05) !important; }
            .rank { position:static !important; background:transparent !important; color:#f2f2f2 !important; border-radius:0 !important; padding:0 !important; font-size:1.05rem !important; font-weight:500 !important; letter-spacing:0 !important; width:auto !important; min-width:0 !important; margin-left:12px !important; margin-right:12px !important; text-align:left !important; line-height:1 !important; flex-shrink:0 !important; }
            .card img { width:2.55rem !important; height:2.55rem !important; aspect-ratio:1/1 !important; border-radius:0.4rem !important; object-fit:cover !important; margin:0 !important; box-shadow:none !important; flex-shrink:0 !important; }
            .card-meta { min-width:0 !important; flex:1 !important; overflow:hidden !important; }
            .card-title { width:100% !important; max-width:100% !important; font-size:0.9rem !important; font-weight:600 !important; line-height:1.2 !important; white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; margin-bottom:0 !important; }
            .card-sub { width:100% !important; max-width:100% !important; font-size:0.8rem !important; line-height:1.2 !important; color:#9f9f9f !important; white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; }
            /* Quiz komprimiert */
            .hl-btn { padding:8px 12px !important; font-size:0.85rem !important; margin:4px !important; }
            #page-games > div:first-of-type { gap:8px !important; margin-bottom:12px !important; }
            .quiz-img { max-width:160px !important; max-height:160px !important; width:100% !important; height:auto !important; }
            .quiz-img-wrapper { margin-bottom:12px !important; }
            .quiz-card h2 { font-size:1rem !important; margin-bottom:6px !important; margin-top:0 !important; }
            .quiz-card h3 { font-size:0.9rem !important; margin:8px 0 4px !important; }
            .quiz-card p { font-size:0.8rem !important; margin-bottom:10px !important; }
            .quiz-options { gap:6px !important; margin-top:10px !important; }
            .quiz-btn { min-height:44px !important; padding:8px 12px !important; font-size:0.82rem !important; }
            .quiz-card { padding:16px 14px !important; margin:8px auto !important; }
            /* Mobile Bottom Navigation */
            .mobile-bottom-nav { position:fixed; left:0; right:0; bottom:0; height:4.2rem; background:rgba(10,10,10,0.96); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-top:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:space-around; z-index:1000; }
            .mobile-nav-item { width:25%; height:100%; border:none; background:transparent; color:#9a9a9a; display:inline-flex; flex-direction:column; align-items:center; justify-content:center; gap:0.22rem; font-size:0.67rem; font-weight:600; cursor:pointer; }
            .mobile-nav-item i { font-size:1rem; }
            .mobile-nav-item.active { color:#1DB954; }
          }
        </style>
      </head>
      <body>
        <div id="dynamic-bg"></div>
        <div id="dark-overlay"></div>
        
        <div class="sidebar">
          <div class="logo-area"><img src="https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" width="30"><h2>Insights.</h2></div>
          <ul class="nav-menu">
            <li id="nav-page-home" data-page="page-home" class="nav-item active" onclick="switchPage('page-home')"><i class="fas fa-home"></i> Home</li>
            <li id="nav-page-tracks" data-page="page-tracks" class="nav-item" onclick="switchPage('page-tracks')"><i class="fas fa-music"></i> Top Tracks</li>
            <li id="nav-page-artists" data-page="page-artists" class="nav-item" onclick="switchPage('page-artists')"><i class="fas fa-microphone"></i> Top Künstler</li>
            <li id="nav-page-games" data-page="page-games" class="nav-item" onclick="switchPage('page-games')"><i class="fas fa-gamepad"></i> Minispiele</li>
            <li id="nav-page-import" data-page="page-import" class="nav-item" onclick="switchPage('page-import')"><i class="fas fa-file-import"></i> Import</li>
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
            <div class="section-header">
              <h2 class="section-title"><i class="fas fa-music"></i> Deine Top Tracks</h2>
              <div class="month-selector-wrap">
                <label class="month-selector-label" for="month-selector">Monat:</label>
                <select id="month-selector" class="month-selector">
                  <option value="current" selected>Aktuell (Spotify API)</option>
                  <option value="2026-04">April 2026</option>
                  <option value="2026-05">Mai 2026</option>
                  <option value="2026-06">Juni 2026</option>
                </select>
              </div>
            </div>
            <div id="month-status-tracks" class="month-status"></div>
            <div class="grid">
              ${tracksArray.length > 0 ? tracksArray.map((t, i) => `
                <div class="card"><span class="rank">#${i + 1}</span><img src="${t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : 'https://via.placeholder.com/150'}">
                  <div class="card-meta"><div class="card-title">${t.name}</div><div class="card-sub">${t.artists && t.artists[0] ? t.artists[0].name : 'Künstler'}</div></div>
                </div>`).join('') : '<p style="color:#535353; padding-left:15px;">Keine Daten verfügbar</p>'}
            </div>
          </div>

          <div id="page-artists" class="app-page">
            <div class="section-header">
              <h2 class="section-title"><i class="fas fa-microphone"></i> Deine Lieblingskünstler</h2>
              <div class="month-selector-wrap">
                <label class="month-selector-label" for="month-selector-artists">Monat:</label>
                <select id="month-selector-artists" class="month-selector">
                  <option value="current" selected>Aktuell (Spotify API)</option>
                  <option value="2026-04">April 2026</option>
                  <option value="2026-05">Mai 2026</option>
                  <option value="2026-06">Juni 2026</option>
                </select>
              </div>
            </div>
            <div id="month-status-artists" class="month-status"></div>
            <div class="grid">
              ${artistsArray.length > 0 ? artistsArray.map((a, i) => `
                <div class="card"><span class="rank">#${i + 1}</span><img src="${a.images && a.images[0] ? a.images[0].url : 'https://via.placeholder.com/150'}">
                  <div class="card-meta"><div class="card-title">${a.name}</div><div class="card-sub">${a.genres && a.genres[0] ? a.genres[0] : 'Künstler'}</div></div>
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

          <div id="page-import" class="app-page">
            <h2 class="section-title"><i class="fas fa-file-import"></i> Spotify-Daten importieren</h2>
            <div style="max-width:560px; margin:0 auto;">
              <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:32px;">
                <p style="color:#b3b3b3; font-size:14px; line-height:1.6; margin-top:0;">Lade deine Streaming-Historie als JSON-Datei hoch (z.&nbsp;B. <code style='color:#1DB954;'>StreamingHistory_music_*.json</code> aus dem Spotify-Datenexport).</p>
                <label style="display:block; margin-bottom:12px; font-size:13px; font-weight:600; color:#b3b3b3;">JSON-Datei auswählen</label>
                <input type="file" id="spotify-import-file" accept=".json" style="display:block; width:100%; padding:10px 14px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:white; font-family:'Poppins',sans-serif; font-size:13px; cursor:pointer; margin-bottom:20px;">
                <button onclick="handleSpotifyImport()" class="hl-btn" style="width:100%; justify-content:center;"><i class="fas fa-upload" style="margin-right:8px;"></i>Importieren</button>
                <div id="import-status" style="margin-top:18px; font-size:13px; line-height:1.6;"></div>
              </div>
            </div>
          </div>
        </div>

        <nav class="mobile-bottom-nav">
          <button class="mobile-nav-item active" data-page="page-home" onclick="switchPage('page-home')">
            <i class="fas fa-house"></i><span>Home</span>
          </button>
          <button class="mobile-nav-item" data-page="page-tracks" onclick="switchPage('page-tracks')">
            <i class="fas fa-music"></i><span>Songs</span>
          </button>
          <button class="mobile-nav-item" data-page="page-artists" onclick="switchPage('page-artists')">
            <i class="fas fa-microphone"></i><span>Künstler</span>
          </button>
          <button class="mobile-nav-item" data-page="page-games" onclick="switchPage('page-games')">
            <i class="fas fa-gamepad"></i><span>Spiele</span>
          </button>
          <button class="mobile-nav-item" data-page="page-import" onclick="switchPage('page-import')">
            <i class="fas fa-file-import"></i><span>Import</span>
          </button>
        </nav>

        <script>
          let isPlayingLive = false, isFetchPending = false;
          let localProgress = 0, localDuration = 0, lastLoadedImage = '';
          let premiumWarningUntil = 0;

          const quizPool = JSON.parse(decodeURIComponent(atob("${base64QuizPool}")));
          const yearPool = JSON.parse(decodeURIComponent(atob("${base64YearPool}")));
          const currentTracksData = JSON.parse(decodeURIComponent(atob("${base64CurrentTracks}")));
          const currentArtistsData = JSON.parse(decodeURIComponent(atob("${base64CurrentArtists}")));
          const highscoreState = { quiz: 0, slider: 0 };

          function findFirstNumber(value) {
            if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
            if (typeof value === 'string') {
              const parsed = parseInt(value, 10);
              if (Number.isFinite(parsed)) return Math.max(0, parsed);
            }
            return null;
          }

          function extractHighscoreValue(payload, game) {
            if (!payload || typeof payload !== 'object') return null;
            const gameKeys = game === 'quiz' ? ['quiz'] : ['slider', 'year'];
            const directCandidates = [
              payload[game],
              payload[game + 'Highscore'],
              payload[game + 'Score'],
              payload[game + 'Best'],
              payload.highscore,
              payload.personalBest,
              payload.bestScore,
              payload.score
            ];

            for (const item of directCandidates) {
              const n = findFirstNumber(item);
              if (n !== null) return n;
            }

            for (const key of gameKeys) {
              const nested = payload[key];
              if (nested && typeof nested === 'object') {
                const nestedCandidates = [nested.highscore, nested.personalBest, nested.bestScore, nested.score, nested.value];
                for (const item of nestedCandidates) {
                  const n = findFirstNumber(item);
                  if (n !== null) return n;
                }
              }
            }

            if (Array.isArray(payload.items)) {
              for (const entry of payload.items) {
                if (!entry || typeof entry !== 'object') continue;
                const gameName = String(entry.game || '').toLowerCase();
                if (gameName && gameKeys.includes(gameName)) {
                  const n = findFirstNumber(entry.highscore ?? entry.personalBest ?? entry.bestScore ?? entry.score ?? entry.value);
                  if (n !== null) return n;
                }
              }
            }

            return null;
          }

          function updateHighscoreBadges() {
            const quizSelectors = [
              '#quiz-highscore', '#quiz-highscore-badge', '#quiz-live-score',
              '[data-highscore-game="quiz"]', '[data-game="quiz"][data-role="highscore"]'
            ];
            const sliderSelectors = [
              '#slider-highscore', '#slider-highscore-badge', '#year-highscore', '#year-live-score',
              '[data-highscore-game="slider"]', '[data-game="slider"][data-role="highscore"]'
            ];

            quizSelectors.forEach((selector) => {
              document.querySelectorAll(selector).forEach((el) => {
                el.innerText = String(highscoreState.quiz);
              });
            });
            sliderSelectors.forEach((selector) => {
              document.querySelectorAll(selector).forEach((el) => {
                el.innerText = String(highscoreState.slider);
              });
            });
          }

          async function loadDashboardData() {
            try {
              const res = await fetch('/api/highscores/me');
              if (!res || !res.ok) return;
              const data = await res.json();
              const quizValue = extractHighscoreValue(data, 'quiz');
              const sliderValue = extractHighscoreValue(data, 'slider');
              if (quizValue !== null) highscoreState.quiz = quizValue;
              if (sliderValue !== null) highscoreState.slider = sliderValue;
              quizHighScore = highscoreState.quiz;
              yearHighScore = highscoreState.slider;
              updateHighscoreBadges();
            } catch (err) {
              console.error('Fehler beim Laden der Highscores:', err);
            }
          }

          async function submitHighscore(game, score) {
            const normalizedGame = game === 'slider' ? 'slider' : 'quiz';
            const scoreNum = Math.max(0, parseInt(score, 10) || 0);
            if (scoreNum <= 0) return;

            try {
              const res = await fetch('/api/highscores', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game: normalizedGame, score: scoreNum })
              });

              if (!res || !res.ok) {
                const fallbackBest = Math.max(
                  normalizedGame === 'quiz' ? highscoreState.quiz : highscoreState.slider,
                  scoreNum
                );
                if (normalizedGame === 'quiz') {
                  highscoreState.quiz = fallbackBest;
                  quizHighScore = fallbackBest;
                } else {
                  highscoreState.slider = fallbackBest;
                  yearHighScore = fallbackBest;
                }
                updateHighscoreBadges();
                return;
              }

              const data = await res.json();
              const postedBest = extractHighscoreValue(data, normalizedGame);
              const nextBest = Math.max(
                normalizedGame === 'quiz' ? highscoreState.quiz : highscoreState.slider,
                scoreNum,
                postedBest === null ? 0 : postedBest
              );

              if (normalizedGame === 'quiz') {
                highscoreState.quiz = nextBest;
                quizHighScore = nextBest;
              } else {
                highscoreState.slider = nextBest;
                yearHighScore = nextBest;
              }
              updateHighscoreBadges();
            } catch (err) {
              console.error('Fehler beim Speichern des Highscores:', err);
            }
          }

          function escapeHtml(value) {
            return String(value || '').replace(/[&<>'"]/g, (char) => {
              const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
              return map[char] || char;
            });
          }

          function setMonthStatus(message, isError) {
            const tracksStatus = document.getElementById('month-status-tracks');
            const artistsStatus = document.getElementById('month-status-artists');
            if (tracksStatus) {
              tracksStatus.textContent = message || '';
              tracksStatus.style.color = isError ? '#ff5252' : '#b3b3b3';
            }
            if (artistsStatus) {
              artistsStatus.textContent = message || '';
              artistsStatus.style.color = isError ? '#ff5252' : '#b3b3b3';
            }
          }

          function renderTrackCards(trackItems) {
            const grid = document.querySelector('#page-tracks .grid');
            if (!grid) return;
            if (!trackItems || trackItems.length === 0) {
              grid.innerHTML = '<p style="color:#535353; padding-left:15px;">Keine Daten verfügbar</p>';
              return;
            }

            grid.innerHTML = trackItems.map((t, i) => {
              const title = escapeHtml(t.title || t.name || 'Unbekannt');
              const artist = escapeHtml(t.artist || 'Künstler');
              const image = escapeHtml(t.image || 'https://via.placeholder.com/150');
              const playCount = Number(t.playCount || 0);
              const subLine = playCount > 0 ? artist + ' • ' + playCount + ' Streams' : artist;
              return '<div class="card">' +
                '<span class="rank">#' + (i + 1) + '</span>' +
                '<img src="' + image + '">' +
                '<div class="card-meta"><div class="card-title">' + title + '</div><div class="card-sub">' + subLine + '</div></div>' +
              '</div>';
            }).join('');
          }

          function renderArtistCards(artistItems) {
            const grid = document.querySelector('#page-artists .grid');
            if (!grid) return;
            if (!artistItems || artistItems.length === 0) {
              grid.innerHTML = '<p style="color:#535353; padding-left:15px;">Keine Daten verfügbar</p>';
              return;
            }

            grid.innerHTML = artistItems.map((a, i) => {
              const name = escapeHtml(a.name || a.artist || 'Unbekannt');
              const genreOrCount = escapeHtml(a.genre || (a.playCount ? a.playCount + ' Streams' : 'Künstler'));
              const image = escapeHtml(a.image || 'https://via.placeholder.com/150');
              return '<div class="card">' +
                '<span class="rank">#' + (i + 1) + '</span>' +
                '<img src="' + image + '">' +
                '<div class="card-meta"><div class="card-title">' + name + '</div><div class="card-sub">' + genreOrCount + '</div></div>' +
              '</div>';
            }).join('');
          }

          function deriveArtistsFromTrackStats(trackItems) {
            const map = new Map();
            (trackItems || []).forEach(t => {
              const artistName = t.artist || 'Unbekannt';
              const current = map.get(artistName) || { name: artistName, image: t.image || 'https://via.placeholder.com/150', playCount: 0 };
              current.playCount += Number(t.playCount || 0) || 1;
              if (!current.image && t.image) current.image = t.image;
              map.set(artistName, current);
            });
            return Array.from(map.values()).sort((a, b) => b.playCount - a.playCount);
          }

          async function loadHistoricalMonth(monthValue) {
            setMonthStatus('Lade historische Monatsdaten…', false);
            try {
              const res = await fetch('/api/stats/month?month=' + encodeURIComponent(monthValue));
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error || 'Monatsauswertung fehlgeschlagen');
              }
              const tracks = Array.isArray(data.tracks) ? data.tracks : [];
              renderTrackCards(tracks);
              renderArtistCards(deriveArtistsFromTrackStats(tracks));
              const [year, month] = monthValue.split('-');
              const date = new Date(year, month - 1);
              const formattedMonth = date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
              setMonthStatus('Historische Ansicht aktiv: ' + formattedMonth, false);
            } catch (err) {
              setMonthStatus('Fehler beim Laden: ' + err.message, true);
              renderTrackCards([]);
              renderArtistCards([]);
            }
          }

          function syncMonthSelectors(value) {
            const tracksSelect = document.getElementById('month-selector');
            const artistsSelect = document.getElementById('month-selector-artists');
            if (tracksSelect && tracksSelect.value !== value) tracksSelect.value = value;
            if (artistsSelect && artistsSelect.value !== value) artistsSelect.value = value;
          }

          let activeMonthValue = 'current';

          async function handleMonthChange(value) {
            const selected = value || 'current';
            activeMonthValue = selected;
            syncMonthSelectors(selected);
            const tabContainer = document.querySelector('.tab-container');
            const dropLimit = document.getElementById('dropdown-limit');
            if (selected === 'current') {
              if (tabContainer) tabContainer.style.display = '';
              if (dropLimit) dropLimit.style.display = '';
              renderTrackCards(currentTracksData);
              renderArtistCards(currentArtistsData);
              setMonthStatus('Aktuelle Spotify-Toplisten aktiv.', false);
              return;
            }
            if (tabContainer) tabContainer.style.display = 'none';
            if (dropLimit) dropLimit.style.display = 'none';
            await loadHistoricalMonth(selected);
          }

          function switchPage(pageId) {
            // 1. Alle Seiten ausblenden
            const pages = ['page-home', 'page-tracks', 'page-artists', 'page-minigames', 'page-games', 'page-import'];
            pages.forEach(p => {
              const el = document.getElementById(p);
              if (el) el.style.display = 'none';
            });

            // 2. Die gewünschte Seite einblenden
            const activePage = document.getElementById(pageId);
            if (activePage) {
              activePage.style.display = 'block';
            }

            // 3. Aktiven Navigations-Punkt umschalten (Sidebar + Mobile Bottom Nav)
            const navItems = document.querySelectorAll('.nav-item[data-page], .mobile-nav-item[data-page]');
            navItems.forEach(item => item.classList.remove('active'));
            document.querySelectorAll('[data-page="' + pageId + '"]').forEach(item => item.classList.add('active'));

            // 4. KLUGE FILTER-STEUERUNG: Zeitfilter auf Home und Minigames komplett verstecken!
            const filterBar = document.getElementById('global-filter-bar');
            const dropLimit = document.getElementById('dropdown-limit');
            const dropRecent = document.getElementById('dropdown-recent');

            if (pageId === 'page-tracks' || pageId === 'page-artists') {
              // Nur bei den Top-Listen zeigen wir die Leiste und das Eintrags-Limit
              if (filterBar) filterBar.style.setProperty('display', 'flex', 'important');
              if (dropLimit) dropLimit.style.setProperty('display', 'flex', 'important');
              if (dropRecent) dropRecent.style.setProperty('display', 'none', 'important');
              // Aktiven Monat nach dem Seitenwechsel neu anwenden (historischer Modus bleibt erhalten)
              setTimeout(function() { handleMonthChange(activeMonthValue); }, 0);
            } else if (pageId === 'page-home') {
              // Auf Home blenden wir die Zeit-Pillen aus, zeigen aber das Verlaufs-Limit rechts!
              if (filterBar) filterBar.style.setProperty('display', 'flex', 'important');
              // Trick: Wir verstecken die Buttons (tab-container) im CSS, lassen das Dropdown aber da
              const tabContainer = document.querySelector('.tab-container');
              if (tabContainer) tabContainer.style.setProperty('display', 'none', 'important');
              
              if (dropLimit) dropLimit.style.setProperty('display', 'none', 'important');
              if (dropRecent) dropRecent.style.setProperty('display', 'flex', 'important');
            } else {
              // Bei Minigames und Import fliegt die komplette Filterleiste raus
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
          let quizHighScore = 0;
          let yearHighScore = 0;

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
              const finalQuizScore = quizScore;
              submitHighscore('quiz', finalQuizScore).catch((err) => {
                console.error('Quiz-Highscore konnte nicht gespeichert werden:', err);
              });

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
              const finalYearScore = yearScore;
              submitHighscore('slider', finalYearScore).catch((err) => {
                console.error('Slider-Highscore konnte nicht gespeichert werden:', err);
              });

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

          async function handleSpotifyImport() {
            const fileInput = document.getElementById('spotify-import-file');
            const statusEl = document.getElementById('import-status');
            if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
              statusEl.innerHTML = '<span style="color:#ff5252;">⚠️ Bitte zuerst eine JSON-Datei auswählen.</span>';
              return;
            }
            statusEl.innerHTML = '<span style="color:#b3b3b3;">⏳ Wird hochgeladen…</span>';
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            try {
              const res = await fetch('/api/import/spotify', { method: 'POST', body: formData });
              const data = await res.json();
              if (res.ok) {
                statusEl.innerHTML = '<span style="color:#1DB954;">✅ ' + (data.message || 'Import erfolgreich.') + '</span>';
              } else {
                statusEl.innerHTML = '<span style="color:#ff5252;">❌ ' + (data.error || 'Unbekannter Fehler.') + '</span>';
              }
            } catch (err) {
              statusEl.innerHTML = '<span style="color:#ff5252;">❌ Netzwerkfehler: ' + err.message + '</span>';
            }
          }

          // ─── BEIM LADEN DER SEITE AUSFÜHREN ──────────────────────────────
          window.addEventListener('DOMContentLoaded', () => {
            const initialPage = "${currentPage}" || "page-home";
            setTimeout(() => switchPage(initialPage), 50);
            loadDashboardData().catch((err) => {
              console.error('Dashboard-Daten konnten nicht geladen werden:', err);
            });
            const monthSelector = document.getElementById('month-selector');
            const monthSelectorArtists = document.getElementById('month-selector-artists');
            if (monthSelector) {
              monthSelector.addEventListener('change', function () {
                handleMonthChange(this.value);
              });
            }
            if (monthSelectorArtists) {
              monthSelectorArtists.addEventListener('change', function () {
                handleMonthChange(this.value);
              });
            }
            handleMonthChange('current');
            updateStatus();
            setInterval(updateStatus, 5000);
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.send('Fehler beim Laden der Seite: ' + (err.message || 'Unbekannter Fehler'));
  }
});

// ─── POST /api/import/spotify ─────────────────────────────────────────────────
app.post('/api/import/spotify', checkAndRefreshUserToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei empfangen.' });
  }

  let entries;
  try {
    entries = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Ungültiges JSON-Format.' });
  }

  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'Die JSON-Datei muss ein Array von Einträgen enthalten.' });
  }

  // Validierung: Spotify-Felder prüfen
  const valid = entries.filter(e =>
    e && typeof e === 'object' && typeof e.ts === 'string' && typeof e.master_metadata_track_name === 'string'
  );

  if (valid.length === 0) {
    return res.status(400).json({ error: 'Keine gültigen Spotify-Einträge gefunden. Erwartet werden Felder: ts, master_metadata_track_name.' });
  }

  // Lokal-Schutz: ohne Cosmos DB nur validieren
  if (!streamHistoryContainer) {
    return res.status(200).json({
      message: `Lokal-Modus: ${valid.length} Streams erfolgreich validiert, aber nicht in Cosmos DB gespeichert (keine Verbindung).`
    });
  }

  const userId = await resolveSpotifyUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Spotify-User konnte nicht ermittelt werden.' });
  }

  // Alle ts-Werte der zu importierenden Einträge sammeln
  const candidateTs = valid.map(e => e.ts).filter(Boolean);

  // Duplikate gegen Cosmos DB prüfen
  const { resources: existingRows } = await streamHistoryContainer.items.query({
    query: 'SELECT c.playedAt FROM c WHERE c.userId = @userId AND ARRAY_CONTAINS(@tsList, c.playedAt)',
    parameters: [
      { name: '@userId', value: userId },
      { name: '@tsList', value: candidateTs }
    ]
  }).fetchAll();

  const knownTs = new Set((existingRows || []).map(r => r.playedAt));
  const newEntries = valid.filter(e => !knownTs.has(e.ts));

  let inserted = 0;
  let errors = 0;
  for (const e of newEntries) {
    const safeTs = String(e.ts).replace(/[:.]/g, '-');
    const trackName = e.master_metadata_track_name || 'Unbekannt';
    const artistName = e.master_metadata_album_artist_name || 'Unbekannt';
    const albumName = e.master_metadata_album_album_name || null;
    const msPlayed = typeof e.ms_played === 'number' ? e.ms_played : null;
    try {
      await streamHistoryContainer.items.upsert({
        id: `${userId}_${safeTs}_import`,
        userId,
        playedAt: e.ts,
        title: trackName,
        artist: artistName,
        album: albumName,
        durationMs: msPlayed,
        source: 'manual-import',
        syncedAt: new Date().toISOString()
      });
      inserted++;
    } catch {
      errors++;
    }
  }

  return res.status(200).json({
    message: `Import abgeschlossen: ${inserted} neue Streams gespeichert, ${valid.length - newEntries.length} Duplikate übersprungen${errors > 0 ? ', ' + errors + ' Fehler.' : '.'}`
  });
});

app.listen(port, () => console.log(`Server läuft auf http://127.0.0.1:${port}`));