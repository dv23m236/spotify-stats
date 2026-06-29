require('dotenv').config(); // Lädt Variablen aus der .env-Datei (lokal) bzw. aus den Azure App Settings

const Express = require('express');
const http = require('http');
const SpotifyWebApi = require('spotify-web-api-node');
const { CosmosClient } = require('@azure/cosmos');
const session = require('express-session');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = Express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});
const port = process.env.PORT || 8000;

const ZURICH_TIMEZONE = 'Europe/Zurich';

function formatZurichTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZURICH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function logWithTimezones(scope, message, level = 'info', err = null) {
  const zurich = formatZurichTimestamp();
  const prefix = `--- [${scope}] [Zurich ${zurich}] ${message} ---`;
  if (level === 'error') {
    if (err) console.error(prefix, err?.message || err);
    else console.error(prefix);
    return;
  }
  console.log(prefix);
}

// Prüft beim Start, ob die wichtigsten Variablen gesetzt sind.
// So gibt's eine klare Fehlermeldung statt eines kryptischen Absturzes mitten im Betrieb.
const requiredEnvVars = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET'];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  logWithTimezones('Fehler', `Fehlende Umgebungsvariablen: ${missingEnvVars.join(', ')}`, 'error');
  logWithTimezones('Fehler', 'Bitte eine .env-Datei anlegen (siehe .env.example) oder in den Azure App Settings setzen', 'error');
  process.exit(1);
}

app.set('trust proxy', 1);

// 1. Express-Session konfigurieren
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: !!process.env.WEBSITE_HOSTNAME, // Auf Azure (HTTPS) automatisch 'true', lokal 'false'
    maxAge: 3600000 // 1 Stunde Gültigkeit
  }
});
app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

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
  const spotifyDisplayName = String(me?.body?.display_name || me?.body?.id || '').trim();
  if (userId && req.session) {
    req.session.spotifyUserId = userId;
    if (spotifyDisplayName) {
      req.session.spotifyDisplayName = spotifyDisplayName;
    }
  }
  return userId;
}

function sanitizeLeaderboardDisplayName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return 'Spotify User';
  return normalized.slice(0, 64);
}

function needsLeaderboardDisplayNameBackfill(doc) {
  const currentDisplayName = sanitizeLeaderboardDisplayName(doc?.displayName ?? '');
  const userId = String(doc?.userId || doc?.id || '').trim();
  return currentDisplayName === 'Spotify User' || (userId && currentDisplayName === userId);
}

async function resolveSpotifyDisplayNameForBackfill(userId, tokenEntry) {
  const fallbackName = sanitizeLeaderboardDisplayName(userId);
  if (!userId) return fallbackName;

  const entry = tokenEntry || tokenRegistry.get(userId) || null;
  if (!entry) return fallbackName;

  const userApi = new SpotifyWebApi(spotifyCredentials);
  if (entry.accessToken) userApi.setAccessToken(entry.accessToken);
  if (entry.refreshToken) userApi.setRefreshToken(entry.refreshToken);

  const tryGetMe = async () => {
    const me = await userApi.getMe();
    return sanitizeLeaderboardDisplayName(me?.body?.display_name || me?.body?.id || userId);
  };

  try {
    return await tryGetMe();
  } catch (err) {
    const unauthorized = err?.statusCode === 401 || String(err?.message || '').includes('The access token expired');
    if (!unauthorized || !entry.refreshToken) {
      return fallbackName;
    }

    try {
      const refreshed = await userApi.refreshAccessToken();
      entry.accessToken = refreshed.body['access_token'] || entry.accessToken || null;
      entry.refreshToken = refreshed.body['refresh_token'] || entry.refreshToken || null;
      entry.tokenExpires = Date.now() + (Number(refreshed.body['expires_in']) || 3600) * 1000;
      tokenRegistry.set(userId, entry);
      try {
        await persistSpotifyTokenDocument(userId, entry, 'app-backfill-refresh');
      } catch (persistErr) {
        logWithTimezones('Backfill', `Token konnte für User ${userId} nicht aktualisiert werden`, 'error', persistErr);
      }
      userApi.setAccessToken(entry.accessToken);
      return await tryGetMe();
    } catch (refreshErr) {
      logWithTimezones('Backfill', `Spotify-Name konnte nicht für User ${userId} aufgelöst werden`, 'error', refreshErr);
      return fallbackName;
    }
  }
}

async function backfillLeaderboardDisplayNames() {
  if (!usersContainer) return { scanned: 0, updated: 0 };

  const { resources: userDocs } = await usersContainer.items.query({
    query: 'SELECT c.id, c.userId, c.displayName, c.quizHighscore, c.sliderHighscore FROM c'
  }).fetchAll();

  let scanned = 0;
  let updated = 0;

  for (const doc of userDocs || []) {
    scanned += 1;
    const userId = String(doc?.userId || doc?.id || '').trim();
    if (!userId || !needsLeaderboardDisplayNameBackfill(doc)) continue;

    const resolvedDisplayName = await resolveSpotifyDisplayNameForBackfill(userId, tokenRegistry.get(userId));
    const currentDisplayName = sanitizeLeaderboardDisplayName(doc?.displayName);
    if (!resolvedDisplayName || resolvedDisplayName === currentDisplayName) continue;

    await upsertUserHighscoreDoc(userId, doc, {
      displayName: resolvedDisplayName,
      quizHighscore: Number(doc?.quizHighscore) || 0,
      sliderHighscore: Number(doc?.sliderHighscore) || 0
    });
    updated += 1;
  }

  logWithTimezones('Backfill', `Leaderboard-DisplayNames geprüft: ${scanned}, aktualisiert: ${updated}`);
  return { scanned, updated };
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
    displayName: sanitizeLeaderboardDisplayName(nextValues.displayName ?? currentDoc?.displayName),
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
const cosmosDatabaseName = process.env.COSMOS_DATABASE_NAME || 'SpotifyStats';
const cosmosClient = cosmosEndpoint && cosmosKey
  ? new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey })
  : null;
let usersContainer = null;
let streamHistoryContainer = null;
let tokenContainer = null;
let cosmosInitPromise = null;

async function ensureCosmosInitialized() {
  if (!cosmosClient) return false;
  if (usersContainer && streamHistoryContainer && tokenContainer) return true;

  if (!cosmosInitPromise) {
    cosmosInitPromise = (async () => {
      try {
        const { database } = await cosmosClient.databases.createIfNotExists({ id: cosmosDatabaseName });
        const { container: userContainer } = await database.containers.createIfNotExists({
          id: 'Users',
          partitionKey: { paths: ['/userId'] }
        });
        const { container: streamContainer } = await database.containers.createIfNotExists({
          id: 'StreamHistory',
          partitionKey: { paths: ['/userId'] }
        });
        const { container: spotifyTokenContainer } = await database.containers.createIfNotExists({
          id: 'SpotifyTokens',
          partitionKey: { paths: ['/userId'] }
        });
        usersContainer = userContainer;
        streamHistoryContainer = streamContainer;
        tokenContainer = spotifyTokenContainer;
        logWithTimezones('System', `Cosmos DB erfolgreich initialisiert (DB: ${cosmosDatabaseName})`);
        return true;
      } catch (err) {
        logWithTimezones('Fehler', 'Cosmos DB Initialisierung fehlgeschlagen', 'error', err);
        return false;
      }
    })();
  }

  return cosmosInitPromise;
}

if (cosmosClient) {
  ensureCosmosInitialized()
    .then(async (ready) => {
      if (!ready) return;
      try {
        await hydrateTokenRegistryFromCosmos();
        await backfillLeaderboardDisplayNames();
      } catch (err) {
        logWithTimezones('Backfill', 'Leaderboard-Backfill fehlgeschlagen', 'error', err);
      }
    })
    .catch((err) => {
      logWithTimezones('Backfill', 'Cosmos-Initialisierung für Backfill fehlgeschlagen', 'error', err);
    });
} else {
  logWithTimezones('System', 'Lokaler Modus ohne Azure Cosmos DB (Variablen fehlen)');
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

// ─── BACKGROUND LIVE-TRACKING (10 MIN INTERVALL) ────────────────────────────
// Token-Registry: userId -> { accessToken, refreshToken, tokenExpires }
// Wird beim Login befüllt und beim Token-Refresh aktualisiert.
// Kein Zugriff auf den Session-Store – kein Konflikt mit dem Login-Flow.
const tokenRegistry = new Map();

const STREAM_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let streamSyncIsRunning = false;

const onlineUsers = new Map();
const socketToUser = new Map();
const pendingChallenges = new Map();
const activeMatches = new Map();

const ROUND_DURATION_MS = 22000;
const CHALLENGE_TIMEOUT_MS = 30000;
const MULTIPLAYER_ROUNDS = 5;
const GLOBAL_TOP_50_PLAYLIST_ID = '37i9dQZEVXbMDoHDwVN2tF';

let appAccessTokenCache = {
  token: null,
  expiresAt: 0
};
const duelPreviewFallbackCache = new Map();

function toSafeDisplayName(value, fallbackUserId) {
  const display = sanitizeLeaderboardDisplayName(value);
  if (display && display !== 'Spotify User') return display;
  return sanitizeLeaderboardDisplayName(fallbackUserId || 'Spotify User');
}

function getUserBusyReason(userId, ignoreChallengeId = null) {
  for (const match of activeMatches.values()) {
    if (match?.status === 'active' && match.players.includes(userId)) {
      return 'match';
    }
  }

  for (const challenge of pendingChallenges.values()) {
    if (ignoreChallengeId && challenge.challengeId === ignoreChallengeId) continue;
    if (challenge.expiresAt <= Date.now()) continue;
    if (challenge.fromUserId === userId || challenge.toUserId === userId) {
      return 'challenge';
    }
  }

  return null;
}

function getOnlineUserRecord(userId) {
  if (!userId) return null;
  return onlineUsers.get(userId) || null;
}

function registerSocketPresence(socket, userId, displayName) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return null;

  const existing = onlineUsers.get(normalizedUserId) || {
    userId: normalizedUserId,
    displayName: toSafeDisplayName(displayName, normalizedUserId),
    sockets: new Set(),
    lastSeenAt: Date.now()
  };

  existing.displayName = toSafeDisplayName(displayName || existing.displayName, normalizedUserId);
  existing.sockets.add(socket.id);
  existing.lastSeenAt = Date.now();
  onlineUsers.set(normalizedUserId, existing);
  socketToUser.set(socket.id, normalizedUserId);
  socket.join(`user:${normalizedUserId}`);
  return existing;
}

function removeSocketPresence(socket) {
  const userId = socketToUser.get(socket.id);
  if (!userId) return null;

  const existing = onlineUsers.get(userId);
  if (existing) {
    existing.sockets.delete(socket.id);
    existing.lastSeenAt = Date.now();
    if (existing.sockets.size === 0) {
      onlineUsers.delete(userId);
      handleUserDisconnectedFromActiveMatch(userId, 'disconnect');
    } else {
      onlineUsers.set(userId, existing);
    }
  }

  socketToUser.delete(socket.id);
  return userId;
}

function getPresencePayload() {
  return Array.from(onlineUsers.values())
    .map((entry) => {
      const busyReason = getUserBusyReason(entry.userId);
      return {
        userId: entry.userId,
        displayName: entry.displayName,
        status: busyReason ? 'busy' : 'available',
        busyReason: busyReason || null
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function broadcastPresence() {
  io.emit('duel:presence', { users: getPresencePayload() });
}

async function ensureAppAccessToken() {
  if (appAccessTokenCache.token && Date.now() < appAccessTokenCache.expiresAt - 30000) {
    return appAccessTokenCache.token;
  }

  const grant = await spotifyApiFactory.clientCredentialsGrant();
  const token = grant?.body?.access_token || null;
  const expiresIn = Number(grant?.body?.expires_in || 3600);
  if (!token) throw new Error('Spotify App Access Token konnte nicht geladen werden.');

  appAccessTokenCache = {
    token,
    expiresAt: Date.now() + (expiresIn * 1000)
  };
  return token;
}

async function getUserTopTracksForDuel(userId) {
  const tokenEntry = tokenRegistry.get(userId);
  if (!tokenEntry || !tokenEntry.accessToken) return [];

  const userApi = new SpotifyWebApi(spotifyCredentials);
  userApi.setAccessToken(tokenEntry.accessToken);
  if (tokenEntry.refreshToken) {
    userApi.setRefreshToken(tokenEntry.refreshToken);
  }

  const withRetry = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      const unauthorized = err?.statusCode === 401 || String(err?.message || '').includes('The access token expired');
      if (!unauthorized || !tokenEntry.refreshToken) throw err;

      const refreshed = await userApi.refreshAccessToken();
      tokenEntry.accessToken = refreshed.body['access_token'] || tokenEntry.accessToken;
      tokenEntry.refreshToken = refreshed.body['refresh_token'] || tokenEntry.refreshToken;
      tokenEntry.tokenExpires = Date.now() + (Number(refreshed.body['expires_in']) || 3600) * 1000;
      tokenRegistry.set(userId, tokenEntry);
      userApi.setAccessToken(tokenEntry.accessToken);
      try {
        await persistSpotifyTokenDocument(userId, tokenEntry, 'app-duel-refresh');
      } catch (persistErr) {
        logWithTimezones('Duel', `Token-Persistenz fehlgeschlagen für ${userId}`, 'error', persistErr);
      }
      return await fn();
    }
  };

  try {
    const [shortTerm, mediumTerm] = await Promise.all([
      withRetry(() => userApi.getMyTopTracks({ limit: 20, time_range: 'short_term' })),
      withRetry(() => userApi.getMyTopTracks({ limit: 20, time_range: 'medium_term' }))
    ]);
    const items = [
      ...(shortTerm?.body?.items || []),
      ...(mediumTerm?.body?.items || [])
    ];
    return items;
  } catch (err) {
    logWithTimezones('Duel', `Top-Tracks konnten nicht geladen werden für ${userId}`, 'error', err);
    return [];
  }
}

async function getUserRecentlyPlayedForDuel(userId) {
  const tokenEntry = tokenRegistry.get(userId);
  if (!tokenEntry || !tokenEntry.accessToken) return [];

  const userApi = new SpotifyWebApi(spotifyCredentials);
  userApi.setAccessToken(tokenEntry.accessToken);
  if (tokenEntry.refreshToken) {
    userApi.setRefreshToken(tokenEntry.refreshToken);
  }

  const withRetry = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      const unauthorized = err?.statusCode === 401 || String(err?.message || '').includes('The access token expired');
      if (!unauthorized || !tokenEntry.refreshToken) throw err;

      const refreshed = await userApi.refreshAccessToken();
      tokenEntry.accessToken = refreshed.body['access_token'] || tokenEntry.accessToken;
      tokenEntry.refreshToken = refreshed.body['refresh_token'] || tokenEntry.refreshToken;
      tokenEntry.tokenExpires = Date.now() + (Number(refreshed.body['expires_in']) || 3600) * 1000;
      tokenRegistry.set(userId, tokenEntry);
      userApi.setAccessToken(tokenEntry.accessToken);
      try {
        await persistSpotifyTokenDocument(userId, tokenEntry, 'app-duel-recent-refresh');
      } catch (persistErr) {
        logWithTimezones('Duel', `Recent-Token-Persistenz fehlgeschlagen für ${userId}`, 'error', persistErr);
      }

      return await fn();
    }
  };

  try {
    const recent = await withRetry(() => userApi.getMyRecentlyPlayedTracks({ limit: 50 }));
    return (recent?.body?.items || []).map((row) => row?.track).filter(Boolean);
  } catch (err) {
    logWithTimezones('Duel', `Recently played konnten nicht geladen werden für ${userId}`, 'error', err);
    return [];
  }
}

async function getGlobalTopTracksForDuel() {
  try {
    const token = await ensureAppAccessToken();
    const appApi = new SpotifyWebApi(spotifyCredentials);
    appApi.setAccessToken(token);

    const tryFetch = async (options) => {
      const data = await appApi.getPlaylistTracks(GLOBAL_TOP_50_PLAYLIST_ID, options);
      return (data?.body?.items || []).map((row) => row?.track).filter(Boolean);
    };

    const attempts = [
      { limit: 50 },
      { limit: 50, market: 'CH' },
      { limit: 50, market: 'US' }
    ];

    for (const options of attempts) {
      try {
        const tracks = await tryFetch(options);
        if (tracks.length > 0) return tracks;
      } catch (err) {
        const statusCode = Number(err?.statusCode || 0);
        const isForbidden = statusCode === 401 || statusCode === 403;
        if (!isForbidden) {
          throw err;
        }
      }
    }

    logWithTimezones('Duel', 'Globale Top-50 lokal nicht verfügbar (Spotify 401/403), verwende nur Spielerpools');
    return [];
  } catch (err) {
    logWithTimezones('Duel', 'Globale Top-50 konnten nicht geladen werden, verwende nur Spielerpools', 'error', err);
    return [];
  }
}

function toQuestionTrack(track) {
  if (!track || !track.id || !track.name) return null;
  const firstArtist = Array.isArray(track.artists) && track.artists[0] ? track.artists[0].name : 'Unbekannt';
  const image = track.album?.images?.[0]?.url || 'https://via.placeholder.com/300';
  return {
    trackId: String(track.id),
    title: String(track.name),
    artist: String(firstArtist),
    image,
    previewUrl: track.preview_url || track.previewUrl || null
  };
}

function normalizeTrackNameForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function findPreviewFallbackForTrack(track) {
  const trackId = String(track?.id || '').trim();
  if (!trackId) return null;
  if (duelPreviewFallbackCache.has(trackId)) {
    return duelPreviewFallbackCache.get(trackId);
  }

  const title = String(track?.name || '').trim();
  const artist = String(track?.artists?.[0]?.name || '').trim();
  if (!title) {
    duelPreviewFallbackCache.set(trackId, null);
    return null;
  }

  const query = encodeURIComponent(`${title} ${artist}`.trim());
  const requestUrl = `https://itunes.apple.com/search?term=${query}&entity=song&limit=8`;

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 2800);
    const response = await fetch(requestUrl, { signal: controller.signal });
    clearTimeout(timeoutHandle);

    if (!response.ok) {
      duelPreviewFallbackCache.set(trackId, null);
      return null;
    }

    const payload = await response.json();
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const normalizedTarget = normalizeTrackNameForMatch(title);

    let preview = null;
    for (const row of results) {
      const candidatePreview = String(row?.previewUrl || '').trim();
      if (!candidatePreview) continue;

      const candidateTrackName = normalizeTrackNameForMatch(row?.trackName || '');
      if (candidateTrackName && normalizedTarget && (candidateTrackName.includes(normalizedTarget) || normalizedTarget.includes(candidateTrackName))) {
        preview = candidatePreview;
        break;
      }

      if (!preview) {
        preview = candidatePreview;
      }
    }

    duelPreviewFallbackCache.set(trackId, preview || null);
    return preview || null;
  } catch (err) {
    duelPreviewFallbackCache.set(trackId, null);
    return null;
  }
}

async function enrichDuelCandidatesWithPreviewFallback(candidates, maxLookups = 30) {
  const pending = [];
  const seen = new Set();

  for (const track of candidates || []) {
    const trackId = String(track?.id || '').trim();
    if (!trackId || seen.has(trackId)) continue;
    seen.add(trackId);

    const existingPreview = String(track?.preview_url || track?.previewUrl || '').trim();
    if (existingPreview) continue;

    pending.push(track);
    if (pending.length >= maxLookups) break;
  }

  await Promise.all(pending.map(async (track) => {
    const fallbackPreview = await findPreviewFallbackForTrack(track);
    if (!fallbackPreview) return;
    track.preview_url = fallbackPreview;
    track.previewUrl = fallbackPreview;
  }));
}

function shuffleArray(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDuelQuestions(candidates, count) {
  const trackMap = new Map();
  for (const item of candidates) {
    const normalized = toQuestionTrack(item);
    if (!normalized) continue;
    if (!trackMap.has(normalized.trackId)) {
      trackMap.set(normalized.trackId, normalized);
    }
  }

  const uniqueTracks = shuffleArray(Array.from(trackMap.values()));
  if (uniqueTracks.length < 4) {
    return [];
  }

  const withPreview = uniqueTracks.filter((track) => !!track.previewUrl);
  const withoutPreview = uniqueTracks.filter((track) => !track.previewUrl);
  const orderedTracks = [...shuffleArray(withPreview), ...shuffleArray(withoutPreview)];

  const selected = [];
  const targetCount = Math.max(count, MULTIPLAYER_ROUNDS);
  while (selected.length < targetCount) {
    selected.push(orderedTracks[selected.length % orderedTracks.length]);
  }

  const questions = [];

  for (const correctTrack of selected) {
    const wrongPool = shuffleArray(uniqueTracks.filter((t) => t.trackId !== correctTrack.trackId));
    const wrongOptions = wrongPool.slice(0, 3);
    if (wrongOptions.length < 3) continue;

    const answerOptions = shuffleArray([
      { trackId: correctTrack.trackId, title: correctTrack.title, isCorrect: true },
      ...wrongOptions.map((opt) => ({ trackId: opt.trackId, title: opt.title, isCorrect: false }))
    ]);

    questions.push({
      questionId: randomUUID(),
      correctTrackId: correctTrack.trackId,
      prompt: {
        title: correctTrack.title,
        artist: correctTrack.artist,
        image: correctTrack.image,
        previewUrl: correctTrack.previewUrl
      },
      options: answerOptions.map((opt) => ({ trackId: opt.trackId, title: opt.title }))
    });

    if (questions.length >= count) break;
  }

  return questions;
}

function clearChallenge(challengeId) {
  const challenge = pendingChallenges.get(challengeId);
  if (!challenge) return;
  if (challenge.timeoutHandle) clearTimeout(challenge.timeoutHandle);
  pendingChallenges.delete(challengeId);
}

function clearRoundTimer(match) {
  if (match?.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }
}

function getMatchByPlayer(userId) {
  for (const match of activeMatches.values()) {
    if (match?.status === 'active' && match.players.includes(userId)) {
      return match;
    }
  }
  return null;
}

function emitToUsers(userIds, eventName, payload) {
  for (const userId of userIds) {
    io.to(`user:${userId}`).emit(eventName, payload);
  }
}

function calculateRoundPoints(answeredAtMs, roundEndsAtMs) {
  const remainingMs = Math.max(0, roundEndsAtMs - answeredAtMs);
  const normalized = remainingMs / ROUND_DURATION_MS;
  const points = Math.max(10, Math.round(normalized * 100));
  return { points, remainingMs };
}

function finalizeMatch(match, reason = 'finished', winnerUserId = null) {
  if (!match) return;

  clearRoundTimer(match);
  match.status = 'finished';
  activeMatches.delete(match.id);

  const payload = {
    matchId: match.id,
    reason,
    winnerUserId,
    scores: match.scores,
    players: match.players.map((userId) => ({
      userId,
      displayName: match.playerDisplayNames[userId] || userId
    })),
    roundsPlayed: match.currentRoundIndex
  };

  emitToUsers(match.players, 'duel:game-over', payload);
  broadcastPresence();
}

function handleUserDisconnectedFromActiveMatch(userId, reason) {
  const match = getMatchByPlayer(userId);
  if (!match) return;
  const opponent = match.players.find((id) => id !== userId) || null;
  finalizeMatch(match, reason || 'disconnect', opponent);
}

function advanceMatchRound(matchId) {
  const match = activeMatches.get(matchId);
  if (!match || match.status !== 'active') return;

  clearRoundTimer(match);
  match.currentRoundIndex += 1;

  if (match.currentRoundIndex >= match.questions.length) {
    const [playerA, playerB] = match.players;
    const scoreA = Number(match.scores[playerA] || 0);
    const scoreB = Number(match.scores[playerB] || 0);
    let winner = null;
    if (scoreA > scoreB) winner = playerA;
    else if (scoreB > scoreA) winner = playerB;
    finalizeMatch(match, 'finished', winner);
    return;
  }

  const question = match.questions[match.currentRoundIndex];
  const startedAt = Date.now();
  const endsAt = startedAt + ROUND_DURATION_MS;

  match.roundState = {
    startedAt,
    endsAt,
    questionId: question.questionId,
    answers: {}
  };

  emitToUsers(match.players, 'duel:question', {
    matchId: match.id,
    roundIndex: match.currentRoundIndex,
    totalRounds: match.questions.length,
    roundDurationMs: ROUND_DURATION_MS,
    endsAt,
    prompt: question.prompt,
    options: question.options
  });

  match.roundTimer = setTimeout(() => {
    resolveRound(match.id, 'timeout');
  }, ROUND_DURATION_MS + 50);
}

function resolveRound(matchId, reason) {
  const match = activeMatches.get(matchId);
  if (!match || match.status !== 'active' || !match.roundState) return;

  clearRoundTimer(match);
  const question = match.questions[match.currentRoundIndex];
  if (!question) {
    finalizeMatch(match, 'error', null);
    return;
  }

  const answers = {};
  for (const playerId of match.players) {
    const response = match.roundState.answers[playerId] || null;
    const isCorrect = response ? response.selectedTrackId === question.correctTrackId : false;
    const points = isCorrect && response ? response.points : 0;
    if (points > 0) {
      match.scores[playerId] = Number(match.scores[playerId] || 0) + points;
    }
    answers[playerId] = {
      selectedTrackId: response?.selectedTrackId || null,
      answeredAt: response?.answeredAt || null,
      isCorrect,
      points,
      remainingMs: response?.remainingMs || 0
    };
  }

  emitToUsers(match.players, 'duel:round-result', {
    matchId: match.id,
    roundIndex: match.currentRoundIndex,
    reason,
    correctTrackId: question.correctTrackId,
    answers,
    scores: match.scores
  });

  match.roundState = null;
  setTimeout(() => {
    advanceMatchRound(match.id);
  }, 1300);
}

async function buildMatchQuestionsForPlayers(playerA, playerB) {
  const [aTopTracks, bTopTracks, aRecentTracks, bRecentTracks, globalTracks] = await Promise.all([
    getUserTopTracksForDuel(playerA),
    getUserTopTracksForDuel(playerB),
    getUserRecentlyPlayedForDuel(playerA),
    getUserRecentlyPlayedForDuel(playerB),
    getGlobalTopTracksForDuel()
  ]);

  const combinedCandidates = [
    ...aTopTracks,
    ...bTopTracks,
    ...aRecentTracks,
    ...bRecentTracks,
    ...globalTracks
  ];

  await enrichDuelCandidatesWithPreviewFallback(combinedCandidates, 40);

  const questions = buildDuelQuestions(combinedCandidates, MULTIPLAYER_ROUNDS);

  return questions;
}

function wireRealtimeHandlers() {
  io.on('connection', (socket) => {
    const reqSession = socket.request?.session || null;
    const userId = String(reqSession?.spotifyUserId || '').trim();
    const displayName = toSafeDisplayName(reqSession?.spotifyDisplayName, userId);

    if (!userId) {
      socket.emit('duel:error', { message: 'Keine gültige Session für Multiplayer gefunden.' });
      socket.disconnect(true);
      return;
    }

    registerSocketPresence(socket, userId, displayName);
    broadcastPresence();

    socket.emit('duel:hello', {
      userId,
      displayName,
      challengeTimeoutMs: CHALLENGE_TIMEOUT_MS,
      roundDurationMs: ROUND_DURATION_MS,
      rounds: MULTIPLAYER_ROUNDS
    });

    socket.on('duel:challenge-user', ({ targetUserId }) => {
      const targetId = String(targetUserId || '').trim();
      const sourceId = socketToUser.get(socket.id);

      if (!sourceId || !targetId) {
        socket.emit('duel:error', { message: 'Ungültige Challenge-Daten.' });
        return;
      }
      if (sourceId === targetId) {
        socket.emit('duel:error', { message: 'Du kannst dich nicht selbst herausfordern.' });
        return;
      }

      const sourceOnline = getOnlineUserRecord(sourceId);
      const targetOnline = getOnlineUserRecord(targetId);
      if (!sourceOnline || !targetOnline) {
        socket.emit('duel:error', { message: 'Der Zielspieler ist nicht online.' });
        return;
      }

      const sourceBusy = getUserBusyReason(sourceId);
      const targetBusy = getUserBusyReason(targetId);
      if (sourceBusy || targetBusy) {
        socket.emit('duel:user-busy', {
          targetUserId: targetId,
          reason: targetBusy || sourceBusy
        });
        return;
      }

      const challengeId = randomUUID();
      const expiresAt = Date.now() + CHALLENGE_TIMEOUT_MS;
      const challengePayload = {
        challengeId,
        fromUserId: sourceId,
        toUserId: targetId,
        createdAt: Date.now(),
        expiresAt,
        timeoutHandle: null
      };

      const timeoutHandle = setTimeout(() => {
        const stale = pendingChallenges.get(challengeId);
        if (!stale) return;
        pendingChallenges.delete(challengeId);
        emitToUsers([stale.fromUserId, stale.toUserId], 'duel:challenge-expired', {
          challengeId,
          fromUserId: stale.fromUserId,
          toUserId: stale.toUserId,
          reason: 'expired'
        });
        broadcastPresence();
      }, CHALLENGE_TIMEOUT_MS + 100);

      challengePayload.timeoutHandle = timeoutHandle;
      pendingChallenges.set(challengeId, challengePayload);

      io.to(`user:${targetId}`).emit('duel:incoming-challenge', {
        challengeId,
        fromUserId: sourceId,
        fromDisplayName: sourceOnline.displayName,
        expiresAt
      });

      io.to(`user:${sourceId}`).emit('duel:challenge-sent', {
        challengeId,
        toUserId: targetId,
        toDisplayName: targetOnline.displayName,
        expiresAt
      });

      broadcastPresence();
    });

    socket.on('duel:challenge-accept', async ({ challengeId }) => {
      const challenge = pendingChallenges.get(String(challengeId || ''));
      const accepterId = socketToUser.get(socket.id);

      if (!challenge || !accepterId || challenge.toUserId !== accepterId) {
        socket.emit('duel:challenge-expired', {
          challengeId: String(challengeId || ''),
          reason: 'unavailable'
        });
        return;
      }

      if (challenge.expiresAt <= Date.now()) {
        clearChallenge(challenge.challengeId);
        emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:challenge-expired', {
          challengeId: challenge.challengeId,
          fromUserId: challenge.fromUserId,
          toUserId: challenge.toUserId,
          reason: 'expired'
        });
        broadcastPresence();
        return;
      }

      const challengerBusy = getUserBusyReason(challenge.fromUserId, challenge.challengeId);
      const accepterBusy = getUserBusyReason(challenge.toUserId, challenge.challengeId);
      if (challengerBusy || accepterBusy) {
        clearChallenge(challenge.challengeId);
        emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:user-busy', {
          targetUserId: challengerBusy ? challenge.fromUserId : challenge.toUserId,
          reason: challengerBusy || accepterBusy
        });
        broadcastPresence();
        return;
      }

      clearChallenge(challenge.challengeId);

      try {
        const questions = await buildMatchQuestionsForPlayers(challenge.fromUserId, challenge.toUserId);
        if (!questions || questions.length < MULTIPLAYER_ROUNDS) {
          emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:error', {
            message: 'Nicht genug Song-Vorschauen für ein Duell verfügbar. Bitte später erneut versuchen.'
          });
          broadcastPresence();
          return;
        }

        const fromRecord = getOnlineUserRecord(challenge.fromUserId);
        const toRecord = getOnlineUserRecord(challenge.toUserId);
        const matchId = randomUUID();
        const match = {
          id: matchId,
          roomId: `duel:${matchId}`,
          players: [challenge.fromUserId, challenge.toUserId],
          playerDisplayNames: {
            [challenge.fromUserId]: fromRecord?.displayName || challenge.fromUserId,
            [challenge.toUserId]: toRecord?.displayName || challenge.toUserId
          },
          questions,
          scores: {
            [challenge.fromUserId]: 0,
            [challenge.toUserId]: 0
          },
          currentRoundIndex: -1,
          roundState: null,
          roundTimer: null,
          status: 'active',
          createdAt: Date.now()
        };

        activeMatches.set(matchId, match);

        emitToUsers(match.players, 'duel:challenge-accepted', {
          challengeId: challenge.challengeId,
          matchId,
          players: match.players.map((playerId) => ({
            userId: playerId,
            displayName: match.playerDisplayNames[playerId]
          }))
        });

        emitToUsers(match.players, 'duel:match-start', {
          matchId,
          players: match.players.map((playerId) => ({
            userId: playerId,
            displayName: match.playerDisplayNames[playerId]
          })),
          totalRounds: match.questions.length,
          roundDurationMs: ROUND_DURATION_MS
        });

        broadcastPresence();
        advanceMatchRound(match.id);
      } catch (err) {
        logWithTimezones('Duel', 'Match konnte nicht gestartet werden', 'error', err);
        emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:error', {
          message: 'Match konnte nicht gestartet werden. Bitte erneut versuchen.'
        });
        broadcastPresence();
      }
    });

    socket.on('duel:challenge-reject', ({ challengeId }) => {
      const challenge = pendingChallenges.get(String(challengeId || ''));
      const rejectorId = socketToUser.get(socket.id);
      if (!challenge || !rejectorId || challenge.toUserId !== rejectorId) {
        socket.emit('duel:error', { message: 'Challenge konnte nicht abgelehnt werden.' });
        return;
      }

      clearChallenge(challenge.challengeId);
      emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:challenge-rejected', {
        challengeId: challenge.challengeId,
        fromUserId: challenge.fromUserId,
        toUserId: challenge.toUserId
      });
      broadcastPresence();
    });

    socket.on('duel:challenge-cancel', ({ challengeId }) => {
      const challenge = pendingChallenges.get(String(challengeId || ''));
      const sourceId = socketToUser.get(socket.id);
      if (!challenge || !sourceId || challenge.fromUserId !== sourceId) {
        socket.emit('duel:challenge-expired', {
          challengeId: String(challengeId || ''),
          reason: 'unavailable'
        });
        return;
      }

      clearChallenge(challenge.challengeId);
      emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:challenge-cancelled', {
        challengeId: challenge.challengeId,
        fromUserId: challenge.fromUserId,
        toUserId: challenge.toUserId,
        reason: 'cancelled'
      });
      broadcastPresence();
    });

    socket.on('duel:answer', ({ matchId, roundIndex, selectedTrackId }) => {
      const match = activeMatches.get(String(matchId || ''));
      const playerId = socketToUser.get(socket.id);
      if (!match || !playerId || !match.players.includes(playerId) || match.status !== 'active') {
        socket.emit('duel:error', { message: 'Antwort konnte nicht verarbeitet werden.' });
        return;
      }

      if (!match.roundState || match.currentRoundIndex !== Number(roundIndex)) {
        socket.emit('duel:error', { message: 'Runde ist nicht mehr aktiv.' });
        return;
      }

      if (match.roundState.answers[playerId]) {
        return;
      }

      const selectedId = String(selectedTrackId || '').trim();
      if (!selectedId) {
        socket.emit('duel:error', { message: 'Ungültige Antwort.' });
        return;
      }

      const answeredAt = Date.now();
      const pointsInfo = calculateRoundPoints(answeredAt, match.roundState.endsAt);
      match.roundState.answers[playerId] = {
        selectedTrackId: selectedId,
        answeredAt,
        points: pointsInfo.points,
        remainingMs: pointsInfo.remainingMs
      };

      emitToUsers(match.players, 'duel:player-answered', {
        matchId: match.id,
        roundIndex: match.currentRoundIndex,
        userId: playerId
      });

      const allAnswered = match.players.every((id) => !!match.roundState.answers[id]);
      if (allAnswered) {
        resolveRound(match.id, 'all_answered');
      }
    });

    socket.on('disconnect', () => {
      const removedUserId = removeSocketPresence(socket);
      if (!removedUserId) return;

      for (const [challengeId, challenge] of pendingChallenges.entries()) {
        if (challenge.fromUserId === removedUserId || challenge.toUserId === removedUserId) {
          clearChallenge(challengeId);
          emitToUsers([challenge.fromUserId, challenge.toUserId], 'duel:challenge-expired', {
            challengeId,
            fromUserId: challenge.fromUserId,
            toUserId: challenge.toUserId,
            reason: 'disconnect'
          });
        }
      }

      broadcastPresence();
    });
  });
}

wireRealtimeHandlers();

async function persistSpotifyTokenDocument(userId, tokenData, sourceLabel = 'app') {
  if (!userId || !tokenData) return;
  if (!tokenContainer) {
    await ensureCosmosInitialized();
  }
  if (!tokenContainer) return;

  const accessToken = tokenData.accessToken || null;
  const refreshToken = tokenData.refreshToken || null;
  const tokenExpires = Number(tokenData.tokenExpires || 0) || null;

  await tokenContainer.items.upsert({
    id: userId,
    userId,
    accessToken,
    refreshToken,
    tokenExpires,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: tokenExpires,
    source: sourceLabel,
    updatedAt: new Date().toISOString()
  });
}

async function syncStreamHistoryForUser(userId, entry) {
  const userApi = new SpotifyWebApi(spotifyCredentials);
  userApi.setAccessToken(entry.accessToken);
  userApi.setRefreshToken(entry.refreshToken);

  // Token erneuern, falls er in weniger als 2 Minuten abläuft
  if (entry.tokenExpires && Date.now() > entry.tokenExpires - 120000) {
    if (!entry.refreshToken) throw new Error('Kein Refresh-Token für User ' + userId);
    const refreshed = await userApi.refreshAccessToken();
    entry.accessToken = refreshed.body['access_token'];
    entry.refreshToken = refreshed.body['refresh_token'] || entry.refreshToken;
    entry.tokenExpires = Date.now() + (refreshed.body['expires_in'] * 1000);
    userApi.setAccessToken(entry.accessToken);
    tokenRegistry.set(userId, entry);
    try {
      await persistSpotifyTokenDocument(userId, entry, 'app-cron-refresh');
    } catch (persistErr) {
      logWithTimezones('Cron', `Token-Persistenz fehlgeschlagen für User ${userId}`, 'error', persistErr);
    }
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
    entry.refreshToken = refreshed.body['refresh_token'] || entry.refreshToken;
    entry.tokenExpires = Date.now() + (refreshed.body['expires_in'] * 1000);
    userApi.setAccessToken(entry.accessToken);
    tokenRegistry.set(userId, entry);
    try {
      await persistSpotifyTokenDocument(userId, entry, 'app-cron-retry-refresh');
    } catch (persistErr) {
      logWithTimezones('Cron', `Token-Persistenz (Retry) fehlgeschlagen für User ${userId}`, 'error', persistErr);
    }
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

  logWithTimezones('Cron', `User ${userId}: ${newStreams.length} neue Streams gespeichert (${items.length} geprüft)`);
}

async function hydrateTokenRegistryFromCosmos() {
  if (!tokenContainer) {
    await ensureCosmosInitialized();
  }
  if (!tokenContainer) return 0;

  const { resources } = await tokenContainer.items.query({
    query: 'SELECT * FROM c'
  }).fetchAll();

  let loaded = 0;
  for (const resource of resources || []) {
    const userId = resource?.userId || resource?.id;
    const accessToken = resource?.accessToken || resource?.access_token || null;
    const refreshToken = resource?.refreshToken || resource?.refresh_token || null;
    const tokenExpires = Number(resource?.tokenExpires ?? resource?.expires_at ?? resource?.expiresAt ?? 0) || null;
    if (!userId || (!accessToken && !refreshToken)) continue;

    tokenRegistry.set(String(userId), {
      accessToken,
      refreshToken,
      tokenExpires
    });
    loaded += 1;
  }

  logWithTimezones('Cron', `Token-Registry aus Cosmos geladen: ${loaded} User`);
  return loaded;
}

async function runStreamHistorySyncJob() {
  if (streamSyncIsRunning) {
    logWithTimezones('Cron', 'StreamHistory-Sync übersprungen: Job läuft bereits');
    return;
  }

  logWithTimezones('Cron', `StreamHistory-Sync gestartet. Registry: ${tokenRegistry.size} User`);

  if (!streamHistoryContainer) {
    logWithTimezones('Cron', 'StreamHistory-Sync übersprungen: StreamHistory-Container nicht verfügbar');
    return;
  }
  if (tokenRegistry.size === 0) {
    try {
      const loaded = await hydrateTokenRegistryFromCosmos();
      if (loaded === 0) {
        logWithTimezones('Cron', 'StreamHistory-Sync übersprungen: Keine Tokens in Cosmos gefunden');
        return;
      }
    } catch (err) {
      logWithTimezones('Cron', 'Token-Registry konnte nicht aus Cosmos geladen werden', 'error', err);
      return;
    }
  }

  streamSyncIsRunning = true;
  try {
    for (const [userId, entry] of tokenRegistry.entries()) {
      logWithTimezones('Cron', `Sync für User ${userId} gestartet`);
      try {
        await syncStreamHistoryForUser(userId, entry);
        logWithTimezones('Cron', `Sync für User ${userId} abgeschlossen`);
      } catch (err) {
        logWithTimezones('Cron', `Fehler für User ${userId}`, 'error', err);
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
          req.session.spotifyDisplayName = String(me?.body?.display_name || me?.body?.id || '').trim();
          tokenRegistry.set(userId, {
            accessToken: req.session.accessToken,
            refreshToken: req.session.refreshToken,
            tokenExpires: req.session.tokenExpires
          });
          try {
            await persistSpotifyTokenDocument(userId, {
              accessToken: req.session.accessToken,
              refreshToken: req.session.refreshToken,
              tokenExpires: req.session.tokenExpires
            }, 'app-login');
            logWithTimezones('System', `Spotify-Token in Cosmos gespeichert für User ${userId}`);
          } catch (tokenPersistErr) {
            logWithTimezones('System', `Spotify-Token konnte nicht gespeichert werden für User ${userId}`, 'error', tokenPersistErr);
          }
        }
      } catch (regErr) {
        logWithTimezones('System', 'Token-Registry-Eintrag fehlgeschlagen', 'error', regErr);
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
      req.session.refreshToken = data.body['refresh_token'] || req.session.refreshToken;
      req.session.tokenExpires = Date.now() + ((Number(data.body['expires_in']) || 3600) * 1000);

      if (req.session.spotifyUserId) {
        tokenRegistry.set(req.session.spotifyUserId, {
          accessToken: req.session.accessToken,
          refreshToken: req.session.refreshToken,
          tokenExpires: req.session.tokenExpires
        });
        try {
          await persistSpotifyTokenDocument(req.session.spotifyUserId, {
            accessToken: req.session.accessToken,
            refreshToken: req.session.refreshToken,
            tokenExpires: req.session.tokenExpires
          }, 'app-session-refresh');
        } catch (tokenPersistErr) {
          logWithTimezones('System', `Spotify-Token konnte nach Refresh nicht gespeichert werden (${req.session.spotifyUserId})`, 'error', tokenPersistErr);
        }
      }

      logWithTimezones('System', `Token für Session ${req.session.id} erneuert`);
    } catch (err) {
      logWithTimezones('System', 'Fehler beim automatischen User-Token-Refresh', 'error', err);
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
    const userId = await resolveSpotifyUserId(req);

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
    logWithTimezones('API', '/api/stats/month Fehler', 'error', err);
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
    logWithTimezones('API', '/api/highscores/me Fehler', 'error', err);
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

    if (!req.session.spotifyDisplayName) {
      try {
        const me = await getUserSpotifyApi(req).getMe();
        req.session.spotifyDisplayName = String(me?.body?.display_name || me?.body?.id || '').trim();
      } catch (displayNameErr) {
        logWithTimezones('API', 'DisplayName konnte für /api/highscores nicht geladen werden', 'error', displayNameErr);
      }
    }

    const currentDoc = await readUserHighscoreDoc(userId);
    const nextDoc = {
      displayName: sanitizeLeaderboardDisplayName(req.session.spotifyDisplayName),
      quizHighscore: Math.max(Number(currentDoc?.quizHighscore) || 0, game === 'quiz' ? scoreInt : 0),
      sliderHighscore: Math.max(Number(currentDoc?.sliderHighscore) || 0, game === 'slider' ? scoreInt : 0)
    };
    const savedDoc = await upsertUserHighscoreDoc(userId, currentDoc, nextDoc);

    return res.json({
      quizHighscore: Number(savedDoc?.quizHighscore) || 0,
      sliderHighscore: Number(savedDoc?.sliderHighscore) || 0
    });
  } catch (err) {
    logWithTimezones('API', '/api/highscores Fehler', 'error', err);
    if (scoreInt > (Number(req.session.highscores[game]) || 0)) {
      req.session.highscores[game] = scoreInt;
    }
    return res.json({
      quizHighscore: Number(req.session.highscores.quiz) || 0,
      sliderHighscore: Number(req.session.highscores.slider) || 0
    });
  }
});

app.get('/api/highscores/global', checkAndRefreshUserToken, async (req, res) => {
  if (!usersContainer) {
    return res.json({ quizTop20: [], sliderTop20: [] });
  }

  try {
    if (!req.session.spotifyDisplayName || !req.session.spotifyUserId) {
      try {
        const me = await getUserSpotifyApi(req).getMe();
        req.session.spotifyUserId = req.session.spotifyUserId || String(me?.body?.id || '').trim();
        req.session.spotifyDisplayName = String(me?.body?.display_name || me?.body?.id || '').trim();
      } catch (displayNameErr) {
        logWithTimezones('API', 'DisplayName konnte für /api/highscores/global nicht geladen werden', 'error', displayNameErr);
      }
    }

    const currentDisplayName = sanitizeLeaderboardDisplayName(req.session.spotifyDisplayName);
    const currentUserId = String(req.session.spotifyUserId || '').trim();
    const currentNameLower = currentDisplayName.toLowerCase();

    const quizQuery = {
      query: 'SELECT TOP 20 c.userId, c.displayName, c.quizHighscore FROM c WHERE IS_DEFINED(c.quizHighscore) ORDER BY c.quizHighscore DESC'
    };
    const sliderQuery = {
      query: 'SELECT TOP 20 c.userId, c.displayName, c.sliderHighscore FROM c WHERE IS_DEFINED(c.sliderHighscore) ORDER BY c.sliderHighscore DESC'
    };

    const [quizRowsResult, sliderRowsResult] = await Promise.all([
      usersContainer.items.query(quizQuery).fetchAll(),
      usersContainer.items.query(sliderQuery).fetchAll()
    ]);

    const quizTop20 = (quizRowsResult?.resources || []).map((row, index) => {
      const displayName = sanitizeLeaderboardDisplayName(row.displayName || row.userId);
      const rowUserId = String(row.userId || '').trim();
      const score = Math.max(0, Math.floor(Number(row.quizHighscore) || 0));
      return {
        rank: index + 1,
        displayName,
        score,
        isCurrentUser: rowUserId ? rowUserId === currentUserId : displayName.toLowerCase() === currentNameLower
      };
    });

    const sliderTop20 = (sliderRowsResult?.resources || []).map((row, index) => {
      const displayName = sanitizeLeaderboardDisplayName(row.displayName || row.userId);
      const rowUserId = String(row.userId || '').trim();
      const score = Math.max(0, Math.floor(Number(row.sliderHighscore) || 0));
      return {
        rank: index + 1,
        displayName,
        score,
        isCurrentUser: rowUserId ? rowUserId === currentUserId : displayName.toLowerCase() === currentNameLower
      };
    });

    return res.json({ quizTop20, sliderTop20 });
  } catch (err) {
    logWithTimezones('API', '/api/highscores/global Fehler', 'error', err);
    return res.status(500).json({ error: 'Globale Rangliste konnte nicht geladen werden.' });
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
          .toplist-title-row { margin-top:30px; margin-bottom:12px; }
          .toplist-title-row .section-title { margin:0; }
          .toplist-control-row { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:12px; }
          .toplist-filter-anchor { flex:1 1 auto; min-width:0; }
          .toplist-filter-anchor #global-filter-bar {
            width:auto !important;
            max-width:none !important;
            margin:0 !important;
          }
          #home-filter-anchor #global-filter-bar {
            width:100% !important;
            max-width:1000px !important;
            margin-bottom:35px !important;
          }
          .games-shell { width:100%; max-width:none; margin:0; }
          .games-title-row { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-top:30px; margin-bottom:18px; }
          .games-title-row .section-title { margin:0; }
          .games-control-row { display:flex; align-items:center; justify-content:space-between; gap:18px; flex-wrap:wrap; margin-bottom:18px; }
          .games-action-grid { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:flex-start; }
          .games-action-card {
            background:rgba(255,255,255,0.03);
            border:1px solid rgba(255,255,255,0.05);
            color:#fff;
            border-radius:999px;
            padding:10px 18px;
            display:inline-flex;
            align-items:center;
            gap:9px;
            font-family:'Poppins',sans-serif;
            font-size:13px;
            font-weight:700;
            cursor:pointer;
            transition:all 0.2s ease;
            white-space:nowrap;
            box-shadow:none;
          }
          .games-action-card:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.12); transform:translateY(-1px); }
          .games-action-card i { color:#1DB954; font-size:15px; }
          .games-tab-bar { display:flex; gap:10px; padding:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:999px; width:fit-content; flex-wrap:wrap; }
          .games-tab-btn { border:none; background:transparent; color:#b3b3b3; padding:9px 18px; border-radius:999px; font-family:'Poppins',sans-serif; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.2s ease; }
          .games-tab-btn:hover { color:#fff; }
          .games-tab-btn.active { background:#1DB954; color:#000; }
          .games-panel { display:none; }
          .games-panel.active { display:block; }
          .games-stage { max-width:720px; margin:0 auto; }
          #game-arena { display:flex; justify-content:center; }
          .games-hint { text-align:center; color:#b3b3b3; margin:0; }
          .duel-lobby-card {
            background:rgba(255,255,255,0.03);
            border:1px solid rgba(255,255,255,0.08);
            border-radius:16px;
            padding:16px;
            margin-bottom:16px;
            box-shadow:0 12px 28px rgba(0,0,0,0.28);
          }
          .duel-lobby-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
          .duel-lobby-title { margin:0; font-size:15px; font-weight:700; display:flex; align-items:center; gap:8px; }
          .duel-status-chip {
            display:inline-flex;
            align-items:center;
            gap:6px;
            border-radius:999px;
            padding:5px 10px;
            font-size:11px;
            font-weight:700;
            border:1px solid rgba(255,255,255,0.15);
            color:#d8d8d8;
            background:rgba(255,255,255,0.04);
          }
          .duel-users-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
          .duel-user-item {
            border:1px solid rgba(255,255,255,0.08);
            border-radius:12px;
            padding:10px;
            background:rgba(255,255,255,0.02);
            display:flex;
            flex-direction:column;
            gap:8px;
          }
          .duel-user-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
          .duel-user-name { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .duel-user-badge {
            font-size:10px;
            letter-spacing:0.4px;
            font-weight:700;
            border-radius:999px;
            padding:4px 8px;
            text-transform:uppercase;
          }
          .duel-user-badge.available { background:rgba(29,185,84,0.18); color:#84ffb4; border:1px solid rgba(29,185,84,0.35); }
          .duel-user-badge.busy { background:rgba(255,170,0,0.16); color:#ffd590; border:1px solid rgba(255,170,0,0.35); }
          .duel-user-actions { display:flex; justify-content:flex-end; }
          .duel-btn {
            border:none;
            border-radius:10px;
            padding:8px 10px;
            font-family:'Poppins',sans-serif;
            font-size:12px;
            font-weight:700;
            cursor:pointer;
            background:#1DB954;
            color:#05210f;
          }
          .duel-btn:disabled { opacity:0.45; cursor:not-allowed; }
          .duel-empty { color:#9f9f9f; font-size:13px; margin:0; }
          .duel-match-card {
            background:rgba(255,255,255,0.03);
            border:1px solid rgba(255,255,255,0.08);
            border-radius:16px;
            padding:16px;
            margin-bottom:16px;
            display:none;
          }
          .duel-match-card.active { display:block; }
          .duel-scoreboard { display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; margin-bottom:12px; }
          .duel-player { background:rgba(255,255,255,0.03); border-radius:10px; padding:10px; border:1px solid rgba(255,255,255,0.06); }
          .duel-player-name { font-size:12px; color:#cfcfcf; margin-bottom:4px; }
          .duel-player-score { font-size:22px; font-weight:800; color:#1DB954; }
          .duel-vs { font-weight:800; color:#7e7e7e; font-size:16px; }
          .duel-round-meta { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:10px; font-size:12px; color:#b3b3b3; }
          .duel-timer { font-weight:700; color:#1DB954; }
          .duel-opponent-state { font-size:12px; color:#b3b3b3; min-height:18px; margin-bottom:10px; }
          .duel-choices { display:grid; grid-template-columns:1fr; gap:8px; }
          .duel-choice {
            background:rgba(255,255,255,0.04);
            border:1px solid rgba(255,255,255,0.08);
            color:#fff;
            text-align:left;
            border-radius:10px;
            padding:10px;
            font-family:'Poppins',sans-serif;
            font-size:13px;
            font-weight:600;
            cursor:pointer;
          }
          .duel-choice:hover { border-color:#1DB954; background:rgba(29,185,84,0.10); }
          .duel-choice:disabled { cursor:not-allowed; opacity:0.6; }
          .duel-choice.correct { border-color:#1DB954; background:rgba(29,185,84,0.18); }
          .duel-choice.wrong { border-color:#ff5252; background:rgba(255,82,82,0.16); }
          .duel-overlay {
            position:fixed;
            top:76px;
            right:18px;
            z-index:1200;
            display:none;
            pointer-events:none;
          }
          .duel-overlay.active { display:block; }
          .duel-modal {
            width:min(390px, calc(100vw - 28px));
            background:linear-gradient(165deg, rgba(22,22,22,0.97), rgba(10,10,10,0.97));
            border:1px solid rgba(255,255,255,0.12);
            border-radius:14px;
            padding:14px;
            box-shadow:0 18px 34px rgba(0,0,0,0.45);
            pointer-events:auto;
            animation:duel-toast-enter 220ms ease;
          }
          .duel-modal h3 { margin:0 0 8px 0; font-size:15px; }
          .duel-modal p { margin:0 0 10px 0; color:#b3b3b3; font-size:12px; line-height:1.35; }
          .duel-modal-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
          .duel-modal-btn {
            border:none;
            border-radius:10px;
            padding:8px 10px;
            font-family:'Poppins',sans-serif;
            font-size:12px;
            font-weight:700;
            cursor:pointer;
          }
          .duel-modal-btn.accept { background:#1DB954; color:#05210f; }
          .duel-modal-btn.reject { background:#2a2a2a; color:#fff; }
          .duel-modal-btn.warn { background:#e57f22; color:#1a1108; }
          #duel-gameover-overlay .duel-modal {
            border-color:rgba(29,185,84,0.34);
            background:
              radial-gradient(120% 180% at 0% 0%, rgba(29,185,84,0.16), rgba(29,185,84,0) 42%),
              linear-gradient(165deg, rgba(22,22,22,0.98), rgba(10,10,10,0.98));
          }
          #duel-gameover-overlay .duel-modal h3 {
            font-size:17px;
            color:#e9fff2;
          }
          #duel-gameover-overlay .duel-modal-actions {
            margin-top:12px;
          }
          .duel-result-score {
            display:block;
            font-size:28px;
            line-height:1;
            margin:4px 0 6px 0;
            font-weight:800;
            letter-spacing:0.3px;
            color:#9ef5be;
          }
          .duel-result-sub {
            display:block;
            font-size:11px;
            color:#9f9f9f;
          }
          .duel-toast-progress {
            width:100%;
            height:6px;
            border-radius:999px;
            background:rgba(255,255,255,0.12);
            overflow:hidden;
            margin:0 0 10px 0;
          }
          .duel-toast-progress-fill {
            width:100%;
            height:100%;
            background:linear-gradient(90deg, #1DB954, #9ef5be);
            transform-origin:left center;
            transform:scaleX(1);
          }
          .duel-toast-meta { font-size:11px; color:#9f9f9f; margin-bottom:10px; }
          .duel-toast-actions-hidden { display:none !important; }
          @keyframes duel-toast-enter {
            from { opacity:0; transform:translateY(-8px) scale(0.98); }
            to { opacity:1; transform:translateY(0) scale(1); }
          }
          .leaderboard-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin:8px 0 26px; }
          .leaderboard-card {
            background:rgba(255,255,255,0.03);
            border:1px solid rgba(255,255,255,0.08);
            border-radius:16px;
            padding:16px;
            box-shadow:0 14px 30px rgba(0,0,0,0.28);
          }
          .leaderboard-title { margin:0 0 12px 0; font-size:16px; font-weight:700; display:flex; align-items:center; gap:8px; }
          .leaderboard-table { width:100%; border-collapse:collapse; table-layout:fixed; }
          .leaderboard-table th,
          .leaderboard-table td { padding:9px 8px; text-align:left; font-size:13px; border-bottom:1px solid rgba(255,255,255,0.06); }
          .leaderboard-table th { color:#b3b3b3; font-size:11px; text-transform:uppercase; letter-spacing:0.7px; }
          .leaderboard-table tbody tr:nth-child(even) { background:rgba(255,255,255,0.02); }
          .leaderboard-rank { width:66px; color:#d4d4d4; font-weight:700; }
          .leaderboard-score { width:80px; text-align:right !important; font-weight:700; color:#1DB954; }
          .leaderboard-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .leaderboard-row--me {
            outline:1px solid rgba(29,185,84,0.85);
            box-shadow:inset 0 0 0 1px rgba(29,185,84,0.45);
            background:rgba(29,185,84,0.12) !important;
          }
          .leaderboard-empty td { color:#8f8f8f; font-style:italic; }
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
            .toplist-title-row { margin-top:0.5rem !important; margin-bottom:0.35rem !important; }
            .toplist-control-row { flex-direction:column !important; align-items:stretch !important; gap:0.4rem !important; margin-bottom:0.4rem !important; }
            .toplist-filter-anchor { width:100% !important; }
            .toplist-filter-anchor #global-filter-bar { width:100% !important; max-width:100% !important; margin:0 0 0.35rem 0 !important; }
            .month-selector-wrap { width:100% !important; justify-content:flex-start !important; }
            .month-selector-label { font-size:0.72rem !important; }
            .month-selector { width:100% !important; border-radius:0.5rem !important; padding:0.38rem 0.48rem !important; font-size:0.74rem !important; }
            .month-status { font-size:0.72rem !important; margin-bottom:0.4rem !important; }
            .leaderboard-grid { grid-template-columns:1fr !important; gap:10px !important; margin-bottom:14px !important; }
            .leaderboard-card { padding:10px !important; border-radius:12px !important; }
            .leaderboard-title { font-size:0.84rem !important; margin-bottom:8px !important; }
            .leaderboard-table th, .leaderboard-table td { padding:7px 6px !important; font-size:0.74rem !important; }
            .leaderboard-table th { font-size:0.64rem !important; }
            .leaderboard-rank { width:52px !important; }
            .leaderboard-score { width:66px !important; }
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
            .games-shell { max-width:100% !important; }
            .games-title-row { align-items:flex-start !important; flex-direction:column !important; gap:0.35rem !important; margin-bottom:0.6rem !important; }
            .games-control-row { flex-direction:column !important; align-items:stretch !important; gap:0.45rem !important; margin-bottom:0.65rem !important; }
            .games-action-grid { width:100% !important; flex-direction:column !important; gap:8px !important; }
            .games-action-card { width:100% !important; justify-content:center !important; padding:0.45rem 0.7rem !important; font-size:0.74rem !important; }
            .games-action-card i { font-size:0.9rem !important; }
            .games-tab-bar { width:100% !important; gap:6px !important; padding:4px !important; }
            .games-tab-btn { flex:1 !important; padding:8px 10px !important; font-size:0.72rem !important; }
            .games-stage { max-width:100% !important; }
            .duel-users-list { grid-template-columns:1fr !important; }
            .duel-scoreboard { grid-template-columns:1fr !important; }
            .duel-vs { text-align:center !important; }
            .leaderboard-grid { grid-template-columns:1fr !important; gap:10px !important; margin-bottom:14px !important; }
            .leaderboard-card { padding:10px !important; border-radius:12px !important; }
            .leaderboard-title { font-size:0.84rem !important; margin-bottom:8px !important; }
            .leaderboard-table th, .leaderboard-table td { padding:7px 6px !important; font-size:0.74rem !important; }
            .leaderboard-table th { font-size:0.64rem !important; }
            .leaderboard-rank { width:52px !important; }
            .leaderboard-score { width:66px !important; }
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
            .games-action-grid { margin-bottom:12px !important; }
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
            <div id="home-filter-anchor"></div>
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
            <div class="toplist-title-row">
              <h2 class="section-title"><i class="fas fa-music"></i> Deine Top Tracks</h2>
            </div>
            <div class="toplist-control-row">
              <div id="tracks-filter-anchor" class="toplist-filter-anchor"></div>
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
            <div class="toplist-title-row">
              <h2 class="section-title"><i class="fas fa-microphone"></i> Deine Lieblingskünstler</h2>
            </div>
            <div class="toplist-control-row">
              <div id="artists-filter-anchor" class="toplist-filter-anchor"></div>
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
            <div class="games-shell">
              <div class="games-title-row">
                <h2 class="section-title"><i class="fas fa-gamepad"></i> Musik-Minispiele</h2>
              </div>

              <div class="games-control-row">
                <div class="games-action-grid" aria-label="Minispiel auswählen">
                  <button class="games-action-card" type="button" onclick="startSongQuiz()">
                    <i class="fas fa-music"></i>
                    <span>Song-Erkennungs-Quiz</span>
                  </button>
                  <button class="games-action-card" type="button" onclick="startYearQuiz()">
                    <i class="fas fa-clock"></i>
                    <span>Release-Jahr-Quiz</span>
                  </button>
                </div>

                <div class="games-tab-bar" role="tablist" aria-label="Minispiele Bereich">
                  <button id="games-tab-games" class="games-tab-btn active" type="button" onclick="switchGamesTab('games')">Spiele</button>
                  <button id="games-tab-duel" class="games-tab-btn" type="button" onclick="switchGamesTab('duel')">Live-Quizduell</button>
                  <button id="games-tab-leaderboard" class="games-tab-btn" type="button" onclick="switchGamesTab('leaderboard')">Leaderboard</button>
                </div>
              </div>

              <div id="games-panel-games" class="games-panel active">
                <div class="games-stage">
                  <div id="game-arena">
                    <p class="games-hint">Wähle oben ein Minispiel aus, um zu starten!</p>
                  </div>
                </div>
              </div>

              <div id="games-panel-duel" class="games-panel">
                <div class="duel-lobby-card" id="duel-lobby-card">
                  <div class="duel-lobby-head">
                    <h3 class="duel-lobby-title"><i class="fas fa-bolt"></i> Live Quizduell</h3>
                    <span class="duel-status-chip" id="duel-connection-chip">Verbinde…</span>
                  </div>
                  <div id="duel-users-list" class="duel-users-list">
                    <p class="duel-empty">Warte auf Online-Spieler…</p>
                  </div>
                </div>

                <div class="duel-match-card" id="duel-match-card">
                  <div class="duel-scoreboard">
                    <div class="duel-player">
                      <div class="duel-player-name" id="duel-player-a-name">Du</div>
                      <div class="duel-player-score" id="duel-player-a-score">0</div>
                    </div>
                    <div class="duel-vs">VS</div>
                    <div class="duel-player">
                      <div class="duel-player-name" id="duel-player-b-name">Gegner</div>
                      <div class="duel-player-score" id="duel-player-b-score">0</div>
                    </div>
                  </div>
                  <div class="duel-round-meta">
                    <span id="duel-round-label">Runde 0/5</span>
                    <span class="duel-timer" id="duel-timer-label">15s</span>
                  </div>
                  <div class="duel-opponent-state" id="duel-opponent-state"></div>
                  <div id="duel-question-anchor"></div>
                </div>
              </div>

              <div id="games-panel-leaderboard" class="games-panel">
                <div class="leaderboard-grid">
                  <div class="leaderboard-card">
                    <h3 class="leaderboard-title"><i class="fas fa-trophy"></i> Globales Quiz Ranking</h3>
                    <table class="leaderboard-table" aria-label="Globales Quiz Ranking">
                      <thead>
                        <tr>
                          <th class="leaderboard-rank">Platz</th>
                          <th>Name</th>
                          <th class="leaderboard-score">Score</th>
                        </tr>
                      </thead>
                      <tbody id="quiz-leaderboard-body">
                        <tr class="leaderboard-empty"><td colspan="3">Lade Rangliste…</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <div class="leaderboard-card">
                    <h3 class="leaderboard-title"><i class="fas fa-sliders"></i> Globales Slider Ranking</h3>
                    <table class="leaderboard-table" aria-label="Globales Slider Ranking">
                      <thead>
                        <tr>
                          <th class="leaderboard-rank">Platz</th>
                          <th>Name</th>
                          <th class="leaderboard-score">Score</th>
                        </tr>
                      </thead>
                      <tbody id="slider-leaderboard-body">
                        <tr class="leaderboard-empty"><td colspan="3">Lade Rangliste…</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
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

        <div class="duel-overlay" id="duel-challenge-overlay">
          <div class="duel-modal">
            <h3 id="duel-challenge-title">Challenge erhalten</h3>
            <div class="duel-toast-progress"><div id="duel-challenge-progress" class="duel-toast-progress-fill"></div></div>
            <p id="duel-challenge-text">Ein Spieler fordert dich heraus.</p>
            <div class="duel-toast-meta" id="duel-challenge-meta"></div>
            <div class="duel-modal-actions" id="duel-incoming-actions">
              <button class="duel-modal-btn reject" id="duel-reject-btn" type="button">Ablehnen</button>
              <button class="duel-modal-btn accept" id="duel-accept-btn" type="button">Annehmen</button>
            </div>
            <div class="duel-modal-actions duel-toast-actions-hidden" id="duel-outgoing-actions">
              <button class="duel-modal-btn warn" id="duel-cancel-outgoing-btn" type="button">Anfrage abbrechen</button>
            </div>
          </div>
        </div>

        <div class="duel-overlay" id="duel-gameover-overlay">
          <div class="duel-modal">
            <h3 id="duel-gameover-title">Duell beendet</h3>
            <p id="duel-gameover-text"></p>
            <div class="duel-modal-actions">
              <button class="duel-modal-btn reject" id="duel-close-gameover-btn" type="button">Schließen</button>
              <button class="duel-modal-btn accept" id="duel-rematch-btn" type="button">Revanche</button>
            </div>
          </div>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
          let isPlayingLive = false, isFetchPending = false;
          let localProgress = 0, localDuration = 0, lastLoadedImage = '';
          let premiumWarningUntil = 0;

          const quizPool = JSON.parse(decodeURIComponent(atob("${base64QuizPool}")));
          const yearPool = JSON.parse(decodeURIComponent(atob("${base64YearPool}")));
          const currentTracksData = JSON.parse(decodeURIComponent(atob("${base64CurrentTracks}")));
          const currentArtistsData = JSON.parse(decodeURIComponent(atob("${base64CurrentArtists}")));
          const highscoreState = { quiz: 0, slider: 0 };
          let duelSocket = null;
          let duelSelfUserId = null;
          let duelLatestPresenceUsers = [];
          let duelPendingIncoming = null;
          let duelPendingOutgoing = null;
          let duelLastOpponent = null;
          let duelState = {
            activeMatchId: null,
            activeRoundIndex: -1,
            totalRounds: 5,
            roundDurationMs: 22000,
            selectedTrackId: null,
            currentCorrectTrackId: null,
            players: [],
            scores: {},
            roundEndsAt: 0,
            voteUnlockAt: 0,
            timerHandle: null,
            answeredUsers: {}
          };
          const DUEL_PREVIEW_SNIPPET_SECONDS = 7;
          const DUEL_PREVIEW_MAX_START_SECONDS = 12;
          const DUEL_VOTE_LOCK_MS = 1000;
          const DUEL_GAME_OVER_AUTO_HIDE_MS = 30000;
          let duelChallengeTimeoutMs = 30000;
          let duelPreviewSnippetTimeoutHandle = null;
          let duelVoteUnlockTimeoutHandle = null;
          let duelChallengeCountdownHandle = null;
          let duelGameOverAutoHideHandle = null;

          function setDuelConnectionState(label, isOnline) {
            const chip = document.getElementById('duel-connection-chip');
            if (!chip) return;
            chip.textContent = label;
            chip.style.borderColor = isOnline ? 'rgba(29,185,84,0.45)' : 'rgba(255,255,255,0.15)';
            chip.style.color = isOnline ? '#84ffb4' : '#d8d8d8';
          }

          function getDuelPlayerDisplayName(userId) {
            const player = (duelState.players || []).find((p) => p.userId === userId);
            return player ? player.displayName : userId;
          }

          function renderDuelUsers(users) {
            const list = document.getElementById('duel-users-list');
            if (!list) return;

            const normalizedSelfUserId = String(duelSelfUserId || '').trim();
            if (!normalizedSelfUserId) {
              list.innerHTML = '<p class="duel-empty">Verbinde dein Profil…</p>';
              return;
            }

            const others = (users || []).filter((u) => String(u?.userId || '').trim() !== normalizedSelfUserId);
            if (others.length === 0) {
              list.innerHTML = '<p class="duel-empty">Noch keine anderen Spieler online.</p>';
              return;
            }

            list.innerHTML = others.map((user) => {
              const busy = user.status !== 'available';
              const statusClass = busy ? 'busy' : 'available';
              const statusLabel = busy ? 'Busy' : 'Online';
              const disabled = busy || !!duelState.activeMatchId ? 'disabled' : '';
              const buttonLabel = busy ? 'Nicht verfügbar' : 'Herausfordern';
              return '' +
                '<div class="duel-user-item">' +
                  '<div class="duel-user-head">' +
                    '<div class="duel-user-name">' + escapeHtml(user.displayName || user.userId) + '</div>' +
                    '<span class="duel-user-badge ' + statusClass + '">' + statusLabel + '</span>' +
                  '</div>' +
                  '<div class="duel-user-actions">' +
                    '<button class="duel-btn" type="button" data-duel-target="' + escapeHtml(user.userId) + '" ' + disabled + '>' + buttonLabel + '</button>' +
                  '</div>' +
                '</div>';
            }).join('');

            list.querySelectorAll('button[data-duel-target]').forEach((button) => {
              button.addEventListener('click', () => {
                if (!duelSocket || !duelSocket.connected) return;
                const targetUserId = button.getAttribute('data-duel-target');
                duelLastOpponent = targetUserId;
                duelSocket.emit('duel:challenge-user', { targetUserId });
              });
            });
          }

          function clearDuelChallengeCountdown() {
            if (duelChallengeCountdownHandle) {
              clearInterval(duelChallengeCountdownHandle);
              duelChallengeCountdownHandle = null;
            }
          }

          function clearDuelGameOverAutoHide() {
            if (duelGameOverAutoHideHandle) {
              clearTimeout(duelGameOverAutoHideHandle);
              duelGameOverAutoHideHandle = null;
            }
          }

          function renderChallengeToastProgress(expiresAt) {
            const fill = document.getElementById('duel-challenge-progress');
            const meta = document.getElementById('duel-challenge-meta');
            if (!fill || !meta) return;

            const totalMs = Math.max(1, Number(duelChallengeTimeoutMs || 30000));
            const leftMs = Math.max(0, Number(expiresAt || 0) - Date.now());
            const ratio = Math.max(0, Math.min(1, leftMs / totalMs));
            fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
            meta.textContent = 'Verbleibend: ' + Math.ceil(leftMs / 1000) + 's';
          }

          function startChallengeToastCountdown(expiresAt) {
            clearDuelChallengeCountdown();
            renderChallengeToastProgress(expiresAt);
            duelChallengeCountdownHandle = setInterval(() => {
              renderChallengeToastProgress(expiresAt);
              if (Date.now() >= Number(expiresAt || 0)) {
                clearDuelChallengeCountdown();
              }
            }, 200);
          }

          function showIncomingChallengeModal(payload) {
            duelPendingIncoming = payload || null;
            duelPendingOutgoing = null;
            const overlay = document.getElementById('duel-challenge-overlay');
            const title = document.getElementById('duel-challenge-title');
            const text = document.getElementById('duel-challenge-text');
            const incomingActions = document.getElementById('duel-incoming-actions');
            const outgoingActions = document.getElementById('duel-outgoing-actions');
            if (title) title.textContent = 'Challenge erhalten';
            if (text) {
              text.textContent = (payload.fromDisplayName || 'Ein Spieler') + ' fordert dich zu einem Quizduell heraus.';
            }
            if (incomingActions) incomingActions.classList.remove('duel-toast-actions-hidden');
            if (outgoingActions) outgoingActions.classList.add('duel-toast-actions-hidden');
            startChallengeToastCountdown(payload?.expiresAt || (Date.now() + duelChallengeTimeoutMs));
            if (overlay) overlay.classList.add('active');
          }

          function showOutgoingChallengeToast(payload) {
            duelPendingIncoming = null;
            duelPendingOutgoing = payload || null;
            const overlay = document.getElementById('duel-challenge-overlay');
            const title = document.getElementById('duel-challenge-title');
            const text = document.getElementById('duel-challenge-text');
            const incomingActions = document.getElementById('duel-incoming-actions');
            const outgoingActions = document.getElementById('duel-outgoing-actions');
            if (title) title.textContent = 'Anfrage gesendet';
            if (text) {
              text.textContent = 'Warte auf Antwort von ' + (payload?.toDisplayName || 'dem Spieler') + '.';
            }
            if (incomingActions) incomingActions.classList.add('duel-toast-actions-hidden');
            if (outgoingActions) outgoingActions.classList.remove('duel-toast-actions-hidden');
            startChallengeToastCountdown(payload?.expiresAt || (Date.now() + duelChallengeTimeoutMs));
            if (overlay) overlay.classList.add('active');
          }

          function hideIncomingChallengeModal() {
            duelPendingIncoming = null;
            duelPendingOutgoing = null;
            clearDuelChallengeCountdown();
            const overlay = document.getElementById('duel-challenge-overlay');
            if (overlay) overlay.classList.remove('active');
          }

          function clearDuelTimer() {
            if (duelState.timerHandle) {
              clearInterval(duelState.timerHandle);
              duelState.timerHandle = null;
            }
          }

          function clearDuelVoteUnlockTimer() {
            if (duelVoteUnlockTimeoutHandle) {
              clearTimeout(duelVoteUnlockTimeoutHandle);
              duelVoteUnlockTimeoutHandle = null;
            }
          }

          function updateDuelTimerLabel() {
            const timerLabel = document.getElementById('duel-timer-label');
            if (!timerLabel) return;
            if (!duelState.roundEndsAt) {
              timerLabel.textContent = Math.ceil((duelState.roundDurationMs || 22000) / 1000) + 's';
              return;
            }
            const leftMs = Math.max(0, duelState.roundEndsAt - Date.now());
            timerLabel.textContent = Math.ceil(leftMs / 1000) + 's';
          }

          function startDuelTimer() {
            clearDuelTimer();
            updateDuelTimerLabel();
            duelState.timerHandle = setInterval(() => {
              updateDuelTimerLabel();
              if (Date.now() >= duelState.roundEndsAt) {
                clearDuelTimer();
              }
            }, 200);
          }

          function renderDuelScoreboard() {
            const matchCard = document.getElementById('duel-match-card');
            if (!matchCard) return;
            const isActive = !!duelState.activeMatchId;
            matchCard.classList.toggle('active', isActive);
            if (!isActive) return;

            const me = (duelState.players || []).find((p) => p.userId === duelSelfUserId) || { userId: duelSelfUserId, displayName: 'Du' };
            const opponent = (duelState.players || []).find((p) => p.userId !== duelSelfUserId) || { userId: 'opponent', displayName: 'Gegner' };

            const aName = document.getElementById('duel-player-a-name');
            const bName = document.getElementById('duel-player-b-name');
            const aScore = document.getElementById('duel-player-a-score');
            const bScore = document.getElementById('duel-player-b-score');
            const roundLabel = document.getElementById('duel-round-label');

            if (aName) aName.textContent = me.displayName + ' (Du)';
            if (bName) bName.textContent = opponent.displayName;
            if (aScore) aScore.textContent = String(duelState.scores[me.userId] || 0);
            if (bScore) bScore.textContent = String(duelState.scores[opponent.userId] || 0);
            if (roundLabel) roundLabel.textContent = 'Runde ' + (duelState.activeRoundIndex + 1) + '/' + duelState.totalRounds;
          }

          function stopDuelPreviewPlayback() {
            if (duelPreviewSnippetTimeoutHandle) {
              clearTimeout(duelPreviewSnippetTimeoutHandle);
              duelPreviewSnippetTimeoutHandle = null;
            }

            const audio = document.getElementById('duel-preview-audio');
            if (!audio) return;

            try {
              audio.pause();
              audio.currentTime = 0;
            } catch (err) {
              // no-op
            }
          }

          async function playDuelPreviewSnippet(triggeredByUser) {
            const audio = document.getElementById('duel-preview-audio');
            const button = document.getElementById('duel-preview-snippet-btn');
            const status = document.getElementById('duel-preview-status');
            if (!audio || !button || !status) return;

            stopDuelPreviewPlayback();
            button.disabled = true;
            status.textContent = 'Spiele 7s-Hörprobe...';

            try {
              if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
                await new Promise((resolve, reject) => {
                  const onLoaded = () => {
                    cleanup();
                    resolve();
                  };
                  const onError = () => {
                    cleanup();
                    reject(new Error('preview-metadata-error'));
                  };
                  const cleanup = () => {
                    audio.removeEventListener('loadedmetadata', onLoaded);
                    audio.removeEventListener('error', onError);
                  };

                  audio.addEventListener('loadedmetadata', onLoaded, { once: true });
                  audio.addEventListener('error', onError, { once: true });
                  audio.load();
                });
              }

              const duration = Number(audio.duration) || 0;
              const latestStart = duration > DUEL_PREVIEW_SNIPPET_SECONDS
                ? Math.min(duration - DUEL_PREVIEW_SNIPPET_SECONDS, DUEL_PREVIEW_MAX_START_SECONDS)
                : 0;
              const startAt = latestStart > 0 ? Math.random() * latestStart : 0;

              audio.currentTime = startAt;
              await audio.play();

              duelPreviewSnippetTimeoutHandle = setTimeout(() => {
                duelPreviewSnippetTimeoutHandle = null;
                try {
                  audio.pause();
                } catch (err) {
                  // no-op
                }
                status.textContent = 'Snippet beendet.';
                button.disabled = false;
              }, DUEL_PREVIEW_SNIPPET_SECONDS * 1000);
            } catch (err) {
              stopDuelPreviewPlayback();
              status.textContent = triggeredByUser
                ? 'Preview konnte nicht abgespielt werden.'
                : 'Autoplay blockiert. Klicke auf "7s-Hörprobe abspielen".';
              button.disabled = false;
            }
          }

          function bindDuelPreviewSnippet() {
            const audio = document.getElementById('duel-preview-audio');
            const button = document.getElementById('duel-preview-snippet-btn');
            const status = document.getElementById('duel-preview-status');
            if (!audio || !button || !status) return;

            button.addEventListener('click', async () => {
              await playDuelPreviewSnippet(true);
            });
          }

          function renderDuelQuestion(payload) {
            stopDuelPreviewPlayback();
            const anchor = document.getElementById('duel-question-anchor');
            if (!anchor) return;

            const prompt = payload.prompt || {};
            const options = Array.isArray(payload.options) ? payload.options : [];
            const image = escapeHtml(prompt.image || 'https://via.placeholder.com/300');
            const previewUrl = prompt.previewUrl ? escapeHtml(prompt.previewUrl) : '';
            const hasPreview = !!previewUrl;
            const snippetStatus = hasPreview ? 'Hörprobe startet automatisch. Du kannst währenddessen antworten.' : 'Für diesen Song gibt es bei Spotify keine Preview.';

            anchor.innerHTML = '' +
              '<div class="quiz-card" style="max-width:100%; margin:0;">' +
                '<div class="quiz-img-wrapper"><img class="quiz-img" src="' + image + '" alt="Song Cover"></div>' +
                '<h3 style="margin-bottom:8px;">Welcher Song gehört zu diesem Cover?</h3>' +
                '<div style="margin:8px 0 14px;">' +
                      '<button id="duel-preview-snippet-btn" class="duel-btn" type="button" ' + (hasPreview ? '' : 'disabled') + '>7s-Hörprobe abspielen</button>' +
                      '<span id="duel-preview-status" style="display:block; margin-top:8px; color:#9b9b9b; font-size:12px;">' + snippetStatus + '</span>' +
                      '<audio id="duel-preview-audio" preload="metadata" style="display:none;">' +
                        '<source src="' + previewUrl + '" type="audio/mpeg">' +
                      '</audio>' +
                    '</div>' +
                '<div class="duel-choices" id="duel-choices"></div>' +
              '</div>';

            if (previewUrl) {
              bindDuelPreviewSnippet();
            }

            const choices = document.getElementById('duel-choices');
            if (!choices) return;
            choices.innerHTML = options.map((opt) => {
              return '<button class="duel-choice" type="button" data-track-id="' + escapeHtml(opt.trackId) + '">' + escapeHtml(opt.title) + '</button>';
            }).join('');

            const nowMs = Date.now();
            const voteLocked = nowMs < duelState.voteUnlockAt;
            choices.querySelectorAll('.duel-choice').forEach((btn) => {
              btn.disabled = voteLocked;
            });
            if (voteLocked) {
              clearDuelVoteUnlockTimer();
              duelVoteUnlockTimeoutHandle = setTimeout(() => {
                duelVoteUnlockTimeoutHandle = null;
                if (duelState.selectedTrackId) return;
                document.querySelectorAll('#duel-choices .duel-choice').forEach((btn) => {
                  btn.disabled = false;
                });
              }, Math.max(0, duelState.voteUnlockAt - nowMs));
            }

            choices.querySelectorAll('.duel-choice').forEach((btn) => {
              btn.addEventListener('click', () => {
                if (!duelSocket || !duelState.activeMatchId || duelState.selectedTrackId) return;
                const selectedTrackId = btn.getAttribute('data-track-id');
                duelState.selectedTrackId = selectedTrackId;
                stopDuelPreviewPlayback();
                duelSocket.emit('duel:answer', {
                  matchId: duelState.activeMatchId,
                  roundIndex: duelState.activeRoundIndex,
                  selectedTrackId
                });
                choices.querySelectorAll('.duel-choice').forEach((other) => {
                  other.disabled = true;
                  if (other === btn) {
                    other.style.borderColor = '#1DB954';
                  }
                });
              });
            });

            if (hasPreview) {
              playDuelPreviewSnippet(false).catch(() => {
                // no-op: fallback text is shown in status line
              });
            }
          }

          function updateOpponentAnsweredState() {
            const el = document.getElementById('duel-opponent-state');
            if (!el) return;
            const opponent = (duelState.players || []).find((p) => p.userId !== duelSelfUserId);
            if (!opponent) {
              el.textContent = '';
              return;
            }
            const opponentAnswered = !!duelState.answeredUsers[opponent.userId];
            el.textContent = opponentAnswered ? opponent.displayName + ' hat geantwortet.' : opponent.displayName + ' wählt noch...';
          }

          function applyRoundResult(payload) {
            const correctTrackId = payload.correctTrackId;
            const choices = document.querySelectorAll('#duel-choices .duel-choice');
            choices.forEach((btn) => {
              const trackId = btn.getAttribute('data-track-id');
              btn.disabled = true;
              if (trackId === correctTrackId) {
                btn.classList.add('correct');
              } else if (duelState.selectedTrackId && trackId === duelState.selectedTrackId) {
                btn.classList.add('wrong');
              }
            });

            duelState.scores = payload.scores || duelState.scores;
            renderDuelScoreboard();
          }

          function closeGameOverOverlay() {
            clearDuelGameOverAutoHide();
            const overlay = document.getElementById('duel-gameover-overlay');
            if (overlay) overlay.classList.remove('active');
          }

          function showGameOverOverlay(payload) {
            const overlay = document.getElementById('duel-gameover-overlay');
            const title = document.getElementById('duel-gameover-title');
            const text = document.getElementById('duel-gameover-text');
            if (!overlay || !title || !text) return;

            const winner = payload.winnerUserId ? getDuelPlayerDisplayName(payload.winnerUserId) : null;
            const myScore = Number((payload.scores || {})[duelSelfUserId] || 0);
            const opponent = (payload.players || []).find((p) => p.userId !== duelSelfUserId);
            const opponentName = escapeHtml(opponent?.displayName || 'Gegner');
            const oppScore = Number((payload.scores || {})[opponent?.userId] || 0);

            if (!winner) {
              title.textContent = 'Unentschieden';
            } else if (payload.winnerUserId === duelSelfUserId) {
              title.textContent = 'Du hast gewonnen!';
            } else {
              title.textContent = winner + ' gewinnt';
            }

            text.innerHTML =
              '<span style="display:block; color:#b3b3b3;">Endstand</span>' +
              '<span class="duel-result-score">' + myScore + ' : ' + oppScore + '</span>' +
              '<span class="duel-result-sub">Du vs ' + opponentName + '</span>';
            overlay.classList.add('active');
            clearDuelGameOverAutoHide();
            duelGameOverAutoHideHandle = setTimeout(() => {
              closeGameOverOverlay();
            }, DUEL_GAME_OVER_AUTO_HIDE_MS);
          }

          function resetDuelState() {
            clearDuelTimer();
            clearDuelVoteUnlockTimer();
            stopDuelPreviewPlayback();
            duelState.activeMatchId = null;
            duelState.activeRoundIndex = -1;
            duelState.roundDurationMs = 22000;
            duelState.selectedTrackId = null;
            duelState.currentCorrectTrackId = null;
            duelState.players = [];
            duelState.scores = {};
            duelState.roundEndsAt = 0;
            duelState.voteUnlockAt = 0;
            duelState.answeredUsers = {};
            const anchor = document.getElementById('duel-question-anchor');
            if (anchor) anchor.innerHTML = '';
            const stateEl = document.getElementById('duel-opponent-state');
            if (stateEl) stateEl.textContent = '';
            renderDuelScoreboard();
          }

          function bindDuelModalButtons() {
            const acceptBtn = document.getElementById('duel-accept-btn');
            const rejectBtn = document.getElementById('duel-reject-btn');
            const closeGameOverBtn = document.getElementById('duel-close-gameover-btn');
            const rematchBtn = document.getElementById('duel-rematch-btn');
            const cancelOutgoingBtn = document.getElementById('duel-cancel-outgoing-btn');

            if (acceptBtn) {
              acceptBtn.addEventListener('click', () => {
                if (!duelSocket || !duelPendingIncoming) return;
                duelSocket.emit('duel:challenge-accept', { challengeId: duelPendingIncoming.challengeId });
                hideIncomingChallengeModal();
              });
            }

            if (rejectBtn) {
              rejectBtn.addEventListener('click', () => {
                if (!duelSocket || !duelPendingIncoming) return;
                duelSocket.emit('duel:challenge-reject', { challengeId: duelPendingIncoming.challengeId });
                hideIncomingChallengeModal();
              });
            }

            if (closeGameOverBtn) {
              closeGameOverBtn.addEventListener('click', () => {
                closeGameOverOverlay();
              });
            }

            if (rematchBtn) {
              rematchBtn.addEventListener('click', () => {
                closeGameOverOverlay();
                if (!duelSocket || !duelSocket.connected || !duelLastOpponent) return;
                duelSocket.emit('duel:challenge-user', { targetUserId: duelLastOpponent });
              });
            }

            if (cancelOutgoingBtn) {
              cancelOutgoingBtn.addEventListener('click', () => {
                if (!duelSocket || !duelPendingOutgoing?.challengeId) return;
                duelSocket.emit('duel:challenge-cancel', { challengeId: duelPendingOutgoing.challengeId });
                setDuelConnectionState('Anfrage wird abgebrochen...', true);
              });
            }
          }

          function setupDuelSocket() {
            if (typeof io !== 'function') {
              console.error('Socket.io Client ist nicht geladen.');
              return;
            }

            duelSocket = io({ withCredentials: true, transports: ['websocket', 'polling'] });

            duelSocket.on('connect', () => {
              setDuelConnectionState('Online', true);
            });

            duelSocket.on('disconnect', () => {
              setDuelConnectionState('Offline', false);
              hideIncomingChallengeModal();
              resetDuelState();
            });

            duelSocket.on('duel:hello', (payload) => {
              duelSelfUserId = payload.userId;
              duelState.totalRounds = Number(payload.rounds || 5);
              duelState.roundDurationMs = Number(payload.roundDurationMs || duelState.roundDurationMs || 22000);
              duelChallengeTimeoutMs = Number(payload.challengeTimeoutMs || duelChallengeTimeoutMs || 30000);
              renderDuelUsers(duelLatestPresenceUsers);
            });

            duelSocket.on('duel:presence', (payload) => {
              duelLatestPresenceUsers = Array.isArray(payload.users) ? payload.users : [];
              renderDuelUsers(duelLatestPresenceUsers);
            });

            duelSocket.on('duel:incoming-challenge', (payload) => {
              showIncomingChallengeModal(payload);
            });

            duelSocket.on('duel:challenge-sent', (payload) => {
              setDuelConnectionState('Challenge gesendet', true);
              duelLastOpponent = payload.toUserId;
              showOutgoingChallengeToast(payload);
            });

            duelSocket.on('duel:challenge-rejected', () => {
              setDuelConnectionState('Challenge abgelehnt', true);
              hideIncomingChallengeModal();
            });

            duelSocket.on('duel:challenge-expired', (payload) => {
              const reason = String(payload?.reason || 'expired');
              const message = reason === 'disconnect'
                ? 'Challenge beendet (Offline)'
                : (reason === 'unavailable' ? 'Challenge nicht mehr verfügbar' : 'Challenge abgelaufen');
              setDuelConnectionState(message, true);
              hideIncomingChallengeModal();
            });

            duelSocket.on('duel:challenge-cancelled', () => {
              setDuelConnectionState('Challenge abgebrochen', true);
              hideIncomingChallengeModal();
            });

            duelSocket.on('duel:user-busy', () => {
              setDuelConnectionState('Spieler ist beschäftigt', true);
            });

            duelSocket.on('duel:challenge-accepted', (payload) => {
              duelLastOpponent = (payload.players || []).find((p) => p.userId !== duelSelfUserId)?.userId || duelLastOpponent;
              setDuelConnectionState('Match startet...', true);
              hideIncomingChallengeModal();
              switchGamesTab('duel');
              switchPage('page-games');
            });

            duelSocket.on('duel:match-start', (payload) => {
              duelState.activeMatchId = payload.matchId;
              duelState.players = Array.isArray(payload.players) ? payload.players : [];
              duelState.totalRounds = Number(payload.totalRounds || 5);
              duelState.roundDurationMs = Number(payload.roundDurationMs || duelState.roundDurationMs || 22000);
              duelState.scores = {};
              duelState.players.forEach((p) => { duelState.scores[p.userId] = 0; });
              duelState.activeRoundIndex = -1;
              duelState.selectedTrackId = null;
              duelState.voteUnlockAt = 0;
              duelState.answeredUsers = {};
              renderDuelScoreboard();
              setDuelConnectionState('Im Match', true);
              switchGamesTab('duel');
            });

            duelSocket.on('duel:question', (payload) => {
              duelState.activeMatchId = payload.matchId;
              duelState.activeRoundIndex = Number(payload.roundIndex || 0);
              duelState.roundDurationMs = Number(payload.roundDurationMs || duelState.roundDurationMs || 22000);
              duelState.roundEndsAt = Number(payload.endsAt || 0);
              duelState.selectedTrackId = null;
              duelState.currentCorrectTrackId = null;
              duelState.voteUnlockAt = Date.now() + DUEL_VOTE_LOCK_MS;
              duelState.answeredUsers = {};
              renderDuelScoreboard();
              renderDuelQuestion(payload);
              updateOpponentAnsweredState();
              startDuelTimer();
            });

            duelSocket.on('duel:player-answered', (payload) => {
              if (!payload || payload.matchId !== duelState.activeMatchId) return;
              duelState.answeredUsers[payload.userId] = true;
              updateOpponentAnsweredState();
            });

            duelSocket.on('duel:round-result', (payload) => {
              if (!payload || payload.matchId !== duelState.activeMatchId) return;
              clearDuelTimer();
              duelState.currentCorrectTrackId = payload.correctTrackId;
              applyRoundResult(payload);
            });

            duelSocket.on('duel:game-over', (payload) => {
              if (!payload) return;
              if (Array.isArray(payload.players)) {
                const opponent = payload.players.find((p) => p.userId !== duelSelfUserId);
                if (opponent) duelLastOpponent = opponent.userId;
              }
              showGameOverOverlay(payload);
              resetDuelState();
              setDuelConnectionState('Online', true);
            });

            duelSocket.on('duel:error', (payload) => {
              const message = payload && payload.message ? payload.message : 'Unbekannter Fehler im Duell.';
              setDuelConnectionState(message, false);
              console.error('Duel-Error:', message);
            });
          }

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

          function renderLeaderboardTable(tableBodyId, entries) {
            const tbody = document.getElementById(tableBodyId);
            if (!tbody) return;

            if (!Array.isArray(entries) || entries.length === 0) {
              tbody.innerHTML = '<tr class="leaderboard-empty"><td colspan="3">Noch keine Scores vorhanden.</td></tr>';
              return;
            }

            tbody.innerHTML = entries.map((entry, idx) => {
              const rank = Math.max(1, parseInt(entry.rank, 10) || (idx + 1));
              const displayName = escapeHtml(entry.displayName || 'Spotify User');
              const score = Math.max(0, parseInt(entry.score, 10) || 0);
              const rowClass = entry.isCurrentUser ? 'leaderboard-row--me' : '';
              return '<tr class="' + rowClass + '">' +
                '<td class="leaderboard-rank">#' + rank + '</td>' +
                '<td class="leaderboard-name">' + displayName + '</td>' +
                '<td class="leaderboard-score">' + score + '</td>' +
              '</tr>';
            }).join('');
          }

          async function loadGlobalLeaderboard() {
            try {
              const res = await fetch('/api/highscores/global');
              if (!res || !res.ok) {
                throw new Error('Leaderboard konnte nicht geladen werden.');
              }
              const data = await res.json();
              renderLeaderboardTable('quiz-leaderboard-body', Array.isArray(data.quizTop20) ? data.quizTop20 : []);
              renderLeaderboardTable('slider-leaderboard-body', Array.isArray(data.sliderTop20) ? data.sliderTop20 : []);
            } catch (err) {
              console.error('Fehler beim Laden des globalen Leaderboards:', err);
              renderLeaderboardTable('quiz-leaderboard-body', []);
              renderLeaderboardTable('slider-leaderboard-body', []);
            }
          }

          let activeGamesTab = 'games';

          function switchGamesTab(tabName) {
            if (tabName === 'leaderboard' || tabName === 'duel' || tabName === 'games') {
              activeGamesTab = tabName;
            } else {
              activeGamesTab = 'games';
            }

            const gamesPanel = document.getElementById('games-panel-games');
            const duelPanel = document.getElementById('games-panel-duel');
            const leaderboardPanel = document.getElementById('games-panel-leaderboard');
            if (gamesPanel) gamesPanel.classList.toggle('active', activeGamesTab === 'games');
            if (duelPanel) duelPanel.classList.toggle('active', activeGamesTab === 'duel');
            if (leaderboardPanel) leaderboardPanel.classList.toggle('active', activeGamesTab === 'leaderboard');

            const gamesTabBtn = document.getElementById('games-tab-games');
            const duelTabBtn = document.getElementById('games-tab-duel');
            const leaderboardTabBtn = document.getElementById('games-tab-leaderboard');
            if (gamesTabBtn) gamesTabBtn.classList.toggle('active', activeGamesTab === 'games');
            if (duelTabBtn) duelTabBtn.classList.toggle('active', activeGamesTab === 'duel');
            if (leaderboardTabBtn) leaderboardTabBtn.classList.toggle('active', activeGamesTab === 'leaderboard');
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
            const homeFilterAnchor = document.getElementById('home-filter-anchor');
            const tracksFilterAnchor = document.getElementById('tracks-filter-anchor');
            const artistsFilterAnchor = document.getElementById('artists-filter-anchor');

            if (pageId === 'page-tracks' || pageId === 'page-artists') {
              if (filterBar) {
                const nextAnchor = pageId === 'page-tracks' ? tracksFilterAnchor : artistsFilterAnchor;
                if (nextAnchor) nextAnchor.appendChild(filterBar);
              }
              // Nur bei den Top-Listen zeigen wir die Leiste und das Eintrags-Limit
              if (filterBar) filterBar.style.setProperty('display', 'flex', 'important');
              if (dropLimit) dropLimit.style.setProperty('display', 'flex', 'important');
              if (dropRecent) dropRecent.style.setProperty('display', 'none', 'important');
              // Aktiven Monat nach dem Seitenwechsel neu anwenden (historischer Modus bleibt erhalten)
              setTimeout(function() { handleMonthChange(activeMonthValue); }, 0);
            } else if (pageId === 'page-home') {
              if (filterBar && homeFilterAnchor) homeFilterAnchor.appendChild(filterBar);
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
            switchGamesTab('games');
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
            switchGamesTab('games');
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
            loadGlobalLeaderboard().catch((err) => {
              console.error('Leaderboard konnte nicht geladen werden:', err);
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
            bindDuelModalButtons();
            setupDuelSocket();
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

httpServer.listen(port, () => logWithTimezones('System', `Server läuft auf http://127.0.0.1:${port}`));