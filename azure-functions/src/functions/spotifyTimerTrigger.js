const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const SpotifyWebApi = require('spotify-web-api-node');

const cronExpression = '0 */10 * * * *';
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const cosmosDatabaseName = process.env.COSMOS_DATABASE_NAME || 'SpotifyStats';
const tokenContainerName = process.env.COSMOS_SPOTIFY_TOKENS_CONTAINER_NAME || 'SpotifyTokens';
const historyContainerName = process.env.COSMOS_STREAM_HISTORY_CONTAINER_NAME || 'StreamHistory';
const tokenPartitionKeyPath = process.env.COSMOS_TOKEN_PARTITION_KEY_PATH || '/userId';
const streamPartitionKeyPath = process.env.COSMOS_STREAM_PARTITION_KEY_PATH || '/userId';
const spotifyUserId = process.env.SPOTIFY_USER_ID || process.env.SPOTIFY_TOKENS_USER_ID || 'default';

const spotifyCredentials = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://localhost'
};

const cosmosClient = cosmosEndpoint && cosmosKey
  ? new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey })
  : null;

let cachedDatabasePromise = null;

async function getDatabase() {
  if (!cosmosClient) return null;
  if (!cachedDatabasePromise) {
    cachedDatabasePromise = cosmosClient.databases.createIfNotExists({ id: cosmosDatabaseName })
      .then(result => result.database);
  }
  return cachedDatabasePromise;
}

async function getContainer(containerId, partitionKeyPath) {
  const database = await getDatabase();
  if (!database) return null;
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: [partitionKeyPath] }
  });
  return container;
}

function decodeTokenBlob(rawValue) {
  if (!rawValue) return null;
  try {
    const text = rawValue.trim().startsWith('{') ? rawValue : Buffer.from(rawValue, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeTokenDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const userId = String(doc.userId || spotifyUserId || 'default');
  const accessToken = doc.accessToken || doc.access_token || doc.spotifyAccessToken || null;
  const refreshToken = doc.refreshToken || doc.refresh_token || doc.spotifyRefreshToken || null;
  const rawTokenExpires = doc.tokenExpires ?? doc.tokenExpiresAt ?? doc.expiresAt ?? doc.expires_at ?? 0;
  const normalizedTokenExpires = Number(rawTokenExpires);
  const tokenExpires = Number.isFinite(normalizedTokenExpires) ? normalizedTokenExpires : null;

  if (!accessToken && !refreshToken) return null;

  return {
    userId,
    accessToken,
    refreshToken,
    tokenExpires,
    source: doc.source || 'unknown'
  };
}

function loadTokenDocFromEnv() {
  const tokenBlob = process.env.SPOTIFY_TOKENS_B64 || process.env.SPOTIFY_TOKENS_JSON;
  const parsedBlob = normalizeTokenDoc(decodeTokenBlob(tokenBlob));
  if (parsedBlob) return parsedBlob;

  const directDoc = normalizeTokenDoc({
    userId: process.env.SPOTIFY_USER_ID || spotifyUserId,
    accessToken: process.env.SPOTIFY_ACCESS_TOKEN,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    tokenExpires: process.env.SPOTIFY_TOKEN_EXPIRES,
    source: 'env'
  });

  return directDoc;
}

async function loadTokenDoc(context) {
  if (cosmosClient) {
    try {
      const tokenContainer = await getContainer(tokenContainerName, tokenPartitionKeyPath);
      if (tokenContainer) {
        const result = await tokenContainer.item(spotifyUserId, spotifyUserId).read();
        console.log("DEBUG - Gesuchte Spotify User ID:", spotifyUserId);
        console.log("DEBUG - Gefundenes Dokument aus Cosmos DB:", JSON.stringify(result?.resource, null, 2));
        const doc = normalizeTokenDoc(result?.resource);
        if (doc) {
          return {
            ...doc,
            source: 'cosmos',
            container: tokenContainer
          };
        }
      }
    } catch (error) {
      if (error?.statusCode !== 404 && error?.code !== 404) {
        context.log(`Token-Lesen aus Cosmos fehlgeschlagen: ${error?.message || error}`);
      }
    }
  }

  const envDoc = loadTokenDocFromEnv();
  if (envDoc) {
    return {
      ...envDoc,
      source: 'env',
      container: null
    };
  }

  return null;
}

async function persistTokenDocIfNeeded(tokenDoc, context) {
  if (!tokenDoc || tokenDoc.source !== 'cosmos' || !tokenDoc.container) return;

  try {
    await tokenDoc.container.items.upsert({
      id: tokenDoc.userId,
      userId: tokenDoc.userId,
      accessToken: tokenDoc.accessToken,
      refreshToken: tokenDoc.refreshToken || null,
      tokenExpires: tokenDoc.tokenExpires || null,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    context.log(`Aktualisieren der Token-Daten in Cosmos fehlgeschlagen: ${error?.message || error}`);
  }
}

async function refreshTokensIfNeeded(tokenDoc, spotifyApi, context) {
  const needsRefresh = !tokenDoc.accessToken || !tokenDoc.tokenExpires || Date.now() > tokenDoc.tokenExpires - 120000;
  if (!needsRefresh || !tokenDoc.refreshToken) return tokenDoc;

  const refreshed = await spotifyApi.refreshAccessToken();
  tokenDoc.accessToken = refreshed?.body?.access_token || tokenDoc.accessToken;
  tokenDoc.tokenExpires = Date.now() + ((Number(refreshed?.body?.expires_in) || 3600) * 1000);
  spotifyApi.setAccessToken(tokenDoc.accessToken);
  await persistTokenDocIfNeeded(tokenDoc, context);
  return tokenDoc;
}

function buildSpotifyApi(tokenDoc) {
  const api = new SpotifyWebApi(spotifyCredentials);
  if (tokenDoc.accessToken) {
    api.setAccessToken(tokenDoc.accessToken);
  }
  if (tokenDoc.refreshToken) {
    api.setRefreshToken(tokenDoc.refreshToken);
  }
  return api;
}

async function syncRecentlyPlayedTracks(context) {
  const tokenDoc = await loadTokenDoc(context);
  if (!tokenDoc || (!tokenDoc.accessToken && !tokenDoc.refreshToken)) {
    context.log('Spotify-Tracking übersprungen: Kein Zugriffstoken gefunden.');
    return;
  }

  const spotifyApi = buildSpotifyApi(tokenDoc);

  try {
    await refreshTokensIfNeeded(tokenDoc, spotifyApi, context);
  } catch (refreshError) {
    context.log(`Token-Refresh fehlgeschlagen: ${refreshError?.message || refreshError}`);
  }

  let recentTracks;
  try {
    recentTracks = await spotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
  } catch (error) {
    const unauthorized = error?.statusCode === 401 || String(error?.message || '').includes('expired');
    if (!unauthorized || !tokenDoc.refreshToken) {
      throw error;
    }

    const refreshed = await spotifyApi.refreshAccessToken();
    tokenDoc.accessToken = refreshed?.body?.access_token || tokenDoc.accessToken;
    tokenDoc.tokenExpires = Date.now() + ((Number(refreshed?.body?.expires_in) || 3600) * 1000);
    spotifyApi.setAccessToken(tokenDoc.accessToken);
    await persistTokenDocIfNeeded(tokenDoc, context);
    recentTracks = await spotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
  }

  const items = recentTracks?.body?.items || [];
  if (items.length === 0) {
    context.log('Keine Recently Played Tracks gefunden.');
    return;
  }

  const historyContainer = await getContainer(historyContainerName, streamPartitionKeyPath);
  if (!historyContainer) {
    context.log('StreamHistory-Container konnte nicht initialisiert werden.');
    return;
  }

  let inserted = 0;
  for (const item of items) {
    const track = item?.track || {};
    const playedAt = item?.played_at;
    if (!playedAt) continue;

    const safePlayedAt = String(playedAt).replace(/[:.]/g, '-');
    const trackId = track.id || 'unknown-track';

    await historyContainer.items.upsert({
      id: `${tokenDoc.userId}_${safePlayedAt}_${trackId}`,
      userId: tokenDoc.userId,
      playedAt,
      trackId,
      title: track.name || 'Unbekannt',
      artist: track.artists && track.artists[0] ? track.artists[0].name : 'Unbekannt',
      album: track.album ? track.album.name : null,
      image: track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
      durationMs: track.duration_ms || null,
      source: 'spotify-timer-trigger',
      syncedAt: new Date().toISOString()
    });
    inserted += 1;
  }

  context.log(`SpotifyTimerTrigger: ${inserted} Tracks in StreamHistory gespeichert.`);
}

app.timer('spotifyTimerTrigger', {
  schedule: cronExpression,
  handler: async (_myTimer, context) => {
    try {
      context.log(`SpotifyTimerTrigger gestartet (${cronExpression}).`);
      await syncRecentlyPlayedTracks(context);
    } catch (error) {
      context.log(`SpotifyTimerTrigger Fehler: ${error?.message || error}`);
    }
  }
});
