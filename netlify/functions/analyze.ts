import type { Handler, HandlerEvent } from "@netlify/functions"
import { getStore } from "@netlify/blobs"

interface TimelineEvent {
  date: string
  type: "taken" | "uploaded" | "archived" | "changed"
  label: string
  detail?: string
  archiveUrl?: string
}

interface AnalyzeResult {
  photoId: string
  userId: string
  title?: string
  author?: string
  thumbnailUrl?: string
  imageUrl?: string
  photoUrl?: string
  timeline: TimelineEvent[]
  sources: string[]
}

const UA            = "flickr-history-app/1.0"
const CACHE_TTL_MS  = 15 * 24 * 60 * 60 * 1000  // 15 days

interface CacheEntry { cachedAt: number; result: AnalyzeResult }

async function getCached(key: string): Promise<AnalyzeResult | null> {
  try {
    const store = getStore("flickr-history")
    const entry = await store.get(key, { type: "json" }) as CacheEntry | null
    if (!entry) return null
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      store.delete(key).catch(() => {})  // expired — evict asynchronously
      return null
    }
    return entry.result
  } catch { return null }
}

async function setCached(key: string, result: AnalyzeResult): Promise<void> {
  try {
    const store = getStore("flickr-history")
    await store.setJSON(key, { cachedAt: Date.now(), result } satisfies CacheEntry)
  } catch { /* non-fatal */ }
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function parseFlickrUrl(raw: string): { userId: string; photoId: string } | null {
  const m = raw.match(/flickr\.com\/photos\/([^/?#]+)\/(\d+)/)
  return m ? { userId: m[1], photoId: m[2] } : null
}

function canonicalUrl(userId: string, photoId: string): string {
  return `https://www.flickr.com/photos/${userId}/${photoId}/`
}

// Parse components out of a Flickr CDN image URL.
// Handles all known CDN domain generations:
//   live.staticflickr.com/{server}/{id}_{secret}_{size}.jpg   (2019–present)
//   farm{N}.staticflickr.com/...                              (~2012–2019)
//   farm{N}.static.flickr.com/...                             (pre-2012)
//   c{N}.staticflickr.com/...                                 (~2014–2016)
function parseFlickrImageUrl(url: string): {
  host: string; server: string; photoId: string; secret: string; pathSuffix: string
} | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/^\/(\d+)\/(\d+)_([a-f0-9]+)/)
    if (!m) return null
    return {
      host: u.hostname,
      server: m[1],
      photoId: m[2],
      secret: m[3],
      // path prefix shared across all CDN domains for the same photo
      pathSuffix: `${m[1]}/${m[2]}_${m[3]}`,
    }
  } catch {
    return null
  }
}

// Rough farm-number estimate from server number (for historical CDN URL generation)
function estimateFarm(server: string): number {
  const s = parseInt(server, 10)
  return isNaN(s) ? 1 : Math.min(9, Math.max(1, Math.ceil(s / 500)))
}

// ── CDX helper ───────────────────────────────────────────────────────────────

// Build a CDX query URL as a raw string — URLSearchParams encodes the colon
// in "filter=statuscode:200" as %3A which the CDX API silently ignores.
function cdxUrl(params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
  return `https://web.archive.org/cdx/search/cdx?${qs}`
}

function parseCdxTimestamp(ts: string): string {
  return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}Z`
}

// ── Flickr oEmbed ─────────────────────────────────────────────────────────────

async function fetchOEmbed(photoUrl: string): Promise<{
  title?: string; author?: string; thumbnailUrl?: string; imageUrl?: string
}> {
  try {
    const u = `https://www.flickr.com/services/oembed/?url=${encodeURIComponent(photoUrl)}&format=json`
    const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) { console.log("[oembed] status", res.status); return {} }
    const d = await res.json() as {
      title?: string; author_name?: string; url?: string; thumbnail_url?: string
    }
    console.log("[oembed] ok, title:", d.title, "imageUrl:", d.url)
    return { title: d.title, author: d.author_name, thumbnailUrl: d.thumbnail_url, imageUrl: d.url }
  } catch (err) {
    console.log("[oembed] error", err)
    return {}
  }
}

// ── Flickr API (optional — set FLICKR_API_KEY in Netlify env) ────────────────

async function fetchFlickrApi(photoId: string): Promise<TimelineEvent[]> {
  const key = process.env.FLICKR_API_KEY
  if (!key) return []
  try {
    const u = `https://api.flickr.com/services/rest/?method=flickr.photos.getInfo&api_key=${key}&photo_id=${photoId}&format=json&nojsoncallback=1`
    const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const d = await res.json() as { photo?: { dates?: { posted?: string; taken?: string; takenunknown?: string } }; stat?: string }
    if (d.stat !== "ok") return []
    const events: TimelineEvent[] = []
    const dates = d.photo?.dates
    if (dates?.posted) {
      const ms = parseInt(dates.posted) * 1000
      if (!isNaN(ms)) events.push({ date: new Date(ms).toISOString(), type: "uploaded", label: "Uploaded to Flickr" })
    }
    if (dates?.taken && dates.takenunknown !== "1") {
      events.push({ date: dates.taken.replace(" ", "T") + "Z", type: "taken", label: "Photo taken (Flickr metadata)" })
    }
    return events
  } catch { return [] }
}

// ── Wayback Machine — photo page history ─────────────────────────────────────

async function fetchWaybackPageHistory(photoUrl: string): Promise<TimelineEvent[]> {
  try {
    // matchType=prefix catches all /in/dateposted-public/ and similar path variants.
    // Use raw string construction — URLSearchParams encodes the colon in filter values.
    const url = cdxUrl({
      url:         photoUrl,
      output:      "json",
      fl:          "timestamp,digest",
      collapse:    "digest",
      matchType:   "prefix",
      limit:       "50",
    })
    console.log("[wayback-page] querying", url)
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) { console.log("[wayback-page] status", res.status); return [] }
    const rows = await res.json() as string[][]
    console.log("[wayback-page] rows:", rows?.length ?? 0)
    if (!rows || rows.length <= 1) return []
    return rows.slice(1).map((row, idx) => {
      const date = parseCdxTimestamp(row[0])
      const archiveUrl = `https://web.archive.org/web/${row[0]}/${photoUrl}`
      return {
        date,
        type: (idx === 0 ? "archived" : "changed") as "archived" | "changed",
        label: idx === 0 ? "First archived by Wayback Machine" : "Page content changed",
        archiveUrl,
      }
    })
  } catch (err) {
    console.log("[wayback-page] error", err)
    return []
  }
}

// ── Wayback Machine — image CDN history (multi-domain) ───────────────────────
//
// Flickr has served images from several CDN domains over time. Query each
// candidate domain so we surface archives from all eras.

async function fetchWaybackImageHistory(imageUrl: string): Promise<TimelineEvent[]> {
  const parsed = parseFlickrImageUrl(imageUrl)
  if (!parsed) return []

  const { host: currentHost, server, pathSuffix } = parsed
  const farm = estimateFarm(server)

  // Candidate domains to check.  Use a Set to avoid querying the same host twice.
  const hosts = new Set([
    currentHost,
    "live.staticflickr.com",
    `farm${farm}.staticflickr.com`,
    `farm${farm}.static.flickr.com`,
    "c1.staticflickr.com",
    "c2.staticflickr.com",
  ])

  const events: TimelineEvent[] = []

  await Promise.allSettled([...hosts].map(async (host) => {
    const targetUrl = `https://${host}/${pathSuffix}`
    const url = cdxUrl({
      url:       targetUrl,
      output:    "json",
      fl:        "timestamp,original",
      matchType: "prefix",
      collapse:  "digest",
      limit:     "5",
    })
    console.log("[wayback-image] querying", host)
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) })
      if (!res.ok) return
      const rows = await res.json() as string[][]
      if (!rows || rows.length <= 1) return
      const [ts, original] = rows[1]  // earliest snapshot
      events.push({
        date: parseCdxTimestamp(ts),
        type: "archived",
        label: `Image first archived (${host})`,
        archiveUrl: `https://web.archive.org/web/${ts}/${original}`,
      })
    } catch { /* ignore per-host failures */ }
  }))

  return events
}

// ── EXIF extraction (zero-dependency, manual JPEG/TIFF parse) ────────────────

async function fetchExif(imageUrl: string): Promise<TimelineEvent[]> {
  try {
    console.log("[exif] fetching", imageUrl)
    let res = await fetch(imageUrl, {
      headers: { "Range": "bytes=0-131071", "User-Agent": UA },
      signal: AbortSignal.timeout(12_000),
    })
    // Some CDNs return 416 Range Not Satisfiable — fall back to full fetch
    if (res.status === 416) {
      console.log("[exif] range not satisfiable, retrying without Range")
      res = await fetch(imageUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) })
    }
    if (!res.ok) { console.log("[exif] bad status", res.status); return [] }

    const buf = new Uint8Array(await res.arrayBuffer())
    console.log("[exif] buffer bytes:", buf.length)
    const d = parseExifDate(buf)
    if (!d) { console.log("[exif] no date found in buffer"); return [] }

    console.log("[exif] found date:", d.date.toISOString())
    return [{
      date: d.date.toISOString(),
      type: "taken",
      label: "Photo taken (EXIF data)",
      detail: d.cameraModel,
    }]
  } catch (err) {
    console.log("[exif] error", err)
    return []
  }
}

interface ExifDateResult { date: Date; cameraModel?: string }

function parseExifDate(data: Uint8Array): ExifDateResult | null {
  if (data.length < 12 || data[0] !== 0xFF || data[1] !== 0xD8) return null

  let pos = 2
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xFF) break
    const marker = data[pos + 1]
    if (marker === 0xDA) break  // Start of Scan

    const segLen = (data[pos + 2] << 8) | data[pos + 3]

    if (marker === 0xE1 && pos + 10 <= data.length) {
      if (
        data[pos+4] === 0x45 && data[pos+5] === 0x78 &&
        data[pos+6] === 0x69 && data[pos+7] === 0x66 &&
        data[pos+8] === 0x00 && data[pos+9] === 0x00
      ) {
        const result = parseTiff(data, pos + 10)
        if (result) return result
      }
    }

    if (segLen < 2) break
    pos += 2 + segLen
  }
  return null
}

function parseTiff(data: Uint8Array, base: number): ExifDateResult | null {
  if (base + 8 > data.length) return null

  const le = data[base] === 0x49

  const u16 = (o: number): number => {
    const p = base + o
    if (p + 2 > data.length) return 0
    return le ? data[p] | (data[p+1] << 8) : (data[p] << 8) | data[p+1]
  }

  const u32 = (o: number): number => {
    const p = base + o
    if (p + 4 > data.length) return 0
    const v = le
      ? (data[p] | (data[p+1] << 8) | (data[p+2] << 16) | (data[p+3] << 24))
      : ((data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3])
    return v >>> 0
  }

  if (u16(2) !== 42) return null

  const readAscii = (e: number): string | null => {
    if (u16(e + 2) !== 2) return null
    const count = u32(e + 4)
    if (count < 2) return null
    const offset = count <= 4 ? e + 8 : u32(e + 8)
    const p = base + offset
    if (p + count > data.length) return null
    let s = ""
    for (let j = 0; j < count - 1; j++) {
      if (data[p + j] === 0) break
      s += String.fromCharCode(data[p + j])
    }
    return s || null
  }

  const scanIfd = (ifdOffset: number, tags: number[]): Map<number, string> => {
    const out = new Map<number, string>()
    if (ifdOffset + 2 > data.length) return out
    const n = u16(ifdOffset)
    for (let i = 0; i < n; i++) {
      const e = ifdOffset + 2 + i * 12
      if (e + 12 > data.length) break
      const tag = u16(e)
      if (tags.includes(tag)) {
        const val = readAscii(e)
        if (val) out.set(tag, val)
      }
    }
    return out
  }

  const ifd0 = u32(4)
  const n0   = u16(ifd0)

  let dateStr: string | null = null
  let make: string | null    = null
  let model: string | null   = null
  let subIfd = -1

  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12
    if (e + 12 > data.length) break
    const tag = u16(e)
    if (tag === 0x8769) subIfd  = u32(e + 8)
    if (tag === 0x0132) dateStr = readAscii(e)
    if (tag === 0x010F) make    = readAscii(e)
    if (tag === 0x0110) model   = readAscii(e)
  }

  if (subIfd > 0) {
    const exif = scanIfd(subIfd, [0x9003, 0x9004])
    dateStr = exif.get(0x9003) ?? exif.get(0x9004) ?? dateStr
  }

  if (!dateStr) return null

  const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null

  const date = new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]))
  if (isNaN(date.getTime())) return null

  const parts = [make, model].filter(Boolean)
  return { date, cameraModel: parts.length ? parts.join(" ") : undefined }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const handler: Handler = async (event: HandlerEvent) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" }
  }

  const rawUrl = event.queryStringParameters?.url
  if (!rawUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing ?url= parameter" }) }
  }

  const parsed = parseFlickrUrl(rawUrl)
  if (!parsed) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid Flickr URL — expected https://www.flickr.com/photos/username/photo-id/" }),
    }
  }

  const { userId, photoId } = parsed
  const canonical = canonicalUrl(userId, photoId)
  const cacheKey  = Buffer.from(canonical).toString("base64url")

  const cached = await getCached(cacheKey)
  if (cached) {
    console.log("[cache] hit", canonical)
    return { statusCode: 200, headers, body: JSON.stringify(cached) }
  }

  // Phase 1: fan out everything that doesn't depend on each other
  const [oembed, pageEvents, flickrApiEvents] = await Promise.all([
    fetchOEmbed(canonical),
    fetchWaybackPageHistory(canonical),
    fetchFlickrApi(photoId),
  ])

  // Phase 2: image-dependent queries (need oEmbed image URL)
  const [exifEvents, imageArchiveEvents] = oembed.imageUrl
    ? await Promise.all([
        fetchExif(oembed.imageUrl),
        fetchWaybackImageHistory(oembed.imageUrl),
      ])
    : [[], []]

  // If EXIF gave a taken date, drop Flickr API's taken date (camera EXIF is more precise)
  const hasCameraTaken = exifEvents.some(e => e.type === "taken")
  const apiEvents = hasCameraTaken
    ? flickrApiEvents.filter(e => e.type !== "taken")
    : flickrApiEvents

  const timeline = [...exifEvents, ...apiEvents, ...pageEvents, ...imageArchiveEvents]
    .sort((a, b) => a.date.localeCompare(b.date))

  const sources: string[] = []
  if (pageEvents.length || imageArchiveEvents.length) sources.push("Wayback Machine")
  if (oembed.title)                                   sources.push("Flickr oEmbed")
  if (exifEvents.length)                              sources.push("EXIF")
  if (flickrApiEvents.length)                         sources.push("Flickr API")

  const result: AnalyzeResult = {
    photoId, userId,
    title:        oembed.title,
    author:       oembed.author,
    thumbnailUrl: oembed.thumbnailUrl,
    imageUrl:     oembed.imageUrl,
    photoUrl:     canonical,
    timeline,
    sources,
  }

  await setCached(cacheKey, result)

  return { statusCode: 200, headers, body: JSON.stringify(result) }
}
