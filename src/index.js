// Backend for divinedada, ported from Netlify to a Cloudflare Worker.
//   GET /api/spotify/login?key=LINK_KEY -> one-time Spotify link (owner only)
//   GET /api/spotify/callback           -> Spotify redirects here; stores the refresh token in KV
//   GET /api/spotify/now                -> public JSON: current track + recently played
//   GET /api/lastfm/now                 -> public JSON from Last.fm (keeps the API key off the page)
// Secrets (Settings > Variables and Secrets): SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_LINK_KEY, LASTFM_API_KEY
// Plain variable: LASTFM_USER
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

const SCOPES = 'user-read-currently-playing user-read-recently-played'
const CACHE_MS = 15_000

const redirectUri = (c) => new URL('/api/spotify/callback', c.req.url).toString()
const basicAuth = (env) => 'Basic ' + btoa((env.SPOTIFY_CLIENT_ID || '') + ':' + (env.SPOTIFY_CLIENT_SECRET || ''))

function safeEqual(a, b) {
  a = String(a); b = String(b)
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

const page = (c, title, msg, status = 200) => c.html(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;background:#070b14;color:#e8eef7;display:grid;place-items:center;min-height:100vh;margin:0">` +
  `<div style="max-width:440px;padding:24px;text-align:center"><h1 style="font-size:22px">${title}</h1><p>${msg}</p>` +
  `<p><a style="color:#2dd4bf" href="/">Back to the site</a></p></div>`, status)

// In-memory caches (per isolate; fine if they reset).
let access = { token: '', exp: 0 }
let cached = { at: 0, body: null }
let lfm = { at: 0, body: null }

async function tokenRequest(env, params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
  if (!res.ok) throw new Error('Spotify token request failed: ' + res.status)
  return res.json()
}

async function getAccessToken(env) {
  if (access.token && Date.now() < access.exp) return access.token
  const saved = await env.SPOTIFY_KV.get('auth', 'json')
  if (!saved?.refresh_token) return null
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: saved.refresh_token })
  if (t.refresh_token && t.refresh_token !== saved.refresh_token) {
    await env.SPOTIFY_KV.put('auth', JSON.stringify({ ...saved, refresh_token: t.refresh_token }))
  }
  access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
  return access.token
}

const simplify = (t) => t && {
  title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '),
  album: t.album?.name || '',
  art: (t.album?.images || []).slice(-2)[0]?.url || t.album?.images?.[0]?.url || '',
  url: t.external_urls?.spotify || ''
}

async function spotify(path, token) {
  const res = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + token } })
  if (res.status === 204) return null
  if (res.status === 401) access = { token: '', exp: 0 }
  if (!res.ok) throw new Error('Spotify API ' + path + ' failed: ' + res.status)
  return res.json()
}

const app = new Hono()

app.get('/api/spotify/login', (c) => {
  const env = c.env
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_LINK_KEY) {
    return page(c, 'Spotify is not set up', 'The Spotify app credentials and link key need to be set as secrets first.', 503)
  }
  if (!safeEqual(c.req.query('key') || '', env.SPOTIFY_LINK_KEY)) {
    return page(c, 'Not allowed', 'This link needs the correct link key.', 403)
  }
  const state = randomHex(16)
  setCookie(c, 'sp_state', state, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/api/spotify', maxAge: 600 })
  const url = new URL('https://accounts.spotify.com/authorize')
  url.search = new URLSearchParams({
    response_type: 'code', client_id: env.SPOTIFY_CLIENT_ID, scope: SCOPES,
    redirect_uri: redirectUri(c), state
  }).toString()
  return c.redirect(url.toString())
})

app.get('/api/spotify/callback', async (c) => {
  const env = c.env
  const state = c.req.query('state'), expected = getCookie(c, 'sp_state')
  deleteCookie(c, 'sp_state', { path: '/api/spotify' })
  if (!state || !expected || !safeEqual(state, expected)) return page(c, 'Link expired', 'Start again from the link page.', 400)
  if (c.req.query('error')) return page(c, 'Spotify link cancelled', 'Nothing was changed.', 400)
  try {
    const t = await tokenRequest(env, { grant_type: 'authorization_code', code: c.req.query('code') || '', redirect_uri: redirectUri(c) })
    const me = await spotify('/me', t.access_token).catch(() => null)
    await env.SPOTIFY_KV.put('auth', JSON.stringify({ refresh_token: t.refresh_token, user: me?.display_name || me?.id || '', linkedAt: new Date().toISOString() }))
    access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
    cached = { at: 0, body: null }
    return page(c, 'Spotify linked', 'Your site now shows what you are listening to.')
  } catch (e) {
    console.error(e)
    return page(c, 'Spotify link failed', 'Spotify did not accept the request. Check the app credentials and redirect URI.', 502)
  }
})

app.get('/api/spotify/now', async (c) => {
  const env = c.env
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  if (cached.body && Date.now() - cached.at < CACHE_MS) return c.json(cached.body)
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return c.json({ linked: false, configured: false })
  try {
    const token = await getAccessToken(env)
    if (!token) return c.json({ linked: false })
    const [now, recent] = await Promise.all([
      spotify('/me/player/currently-playing?additional_types=track', token),
      spotify('/me/player/recently-played?limit=5', token)
    ])
    const current = now?.item && now.currently_playing_type === 'track' ? simplify(now.item) : null
    const history = (recent?.items || []).map((i) => simplify(i.track))
    const body = {
      linked: true,
      playing: Boolean(current && now.is_playing),
      track: current || history[0] || null,
      recent: history.filter((t) => !current || t.url !== current.url).slice(current ? 0 : 1, (current ? 0 : 1) + 3)
    }
    cached = { at: Date.now(), body }
    return c.json(body)
  } catch (e) {
    console.error(e)
    if (cached.body) return c.json(cached.body)
    return c.json({ linked: true, error: 'unavailable' }, 502)
  }
})

// Last.fm, proxied so the browser only talks to this site (no CORS, no blockers, key stays secret).
app.get('/api/lastfm/now', async (c) => {
  const env = c.env
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  if (!env.LASTFM_API_KEY || !env.LASTFM_USER) return c.json({ linked: false, configured: false })
  if (lfm.body && Date.now() - lfm.at < CACHE_MS) return c.json(lfm.body)
  try {
    const url = 'https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&format=json&limit=5' +
      '&user=' + encodeURIComponent(env.LASTFM_USER) + '&api_key=' + encodeURIComponent(env.LASTFM_API_KEY)
    const res = await fetch(url)
    const data = await res.json()
    if (data.error) return c.json({ linked: false, error: data.message || 'lastfm error' }, 502)
    const tracks = data.recenttracks?.track || []
    if (!tracks.length) return c.json({ linked: false })
    const pick = (x) => ({
      title: x.name, artist: x.artist?.['#text'] || '',
      art: ((x.image || []).find((i) => i.size === 'large') || {})['#text'] || '', url: x.url || ''
    })
    const first = tracks[0], playing = first['@attr']?.nowplaying === 'true'
    const body = {
      linked: true, playing, track: pick(first),
      at: !playing && first.date ? Number(first.date.uts) * 1000 : null,
      recent: tracks.slice(1, 4).map(pick)
    }
    lfm = { at: Date.now(), body }
    return c.json(body)
  } catch (e) {
    console.error(e)
    if (lfm.body) return c.json(lfm.body)
    return c.json({ linked: true, error: 'unavailable' }, 502)
  }
})

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

export default app
