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
  photoUrl?: string
  timeline: TimelineEvent[]
  sources: string[]
}

interface ErrorResult {
  error: string
}

const form       = document.getElementById("search-form")      as HTMLFormElement
const urlInput   = document.getElementById("url-input")        as HTMLInputElement
const submitBtn  = document.getElementById("submit-btn")       as HTMLButtonElement
const results    = document.getElementById("results")          as HTMLElement
const loadingEl  = document.getElementById("loading")          as HTMLElement
const errorBox   = document.getElementById("error-box")        as HTMLElement
const photoCard  = document.getElementById("photo-card")       as HTMLElement
const photoThumb = document.getElementById("photo-thumb")      as HTMLImageElement
const photoTitle = document.getElementById("photo-title")      as HTMLElement
const photoAuthor= document.getElementById("photo-author")     as HTMLElement
const photoLink  = document.getElementById("photo-link")       as HTMLAnchorElement
const sourcesRow = document.getElementById("sources-row")      as HTMLElement
const tlSection  = document.getElementById("timeline-section") as HTMLElement
const tlList     = document.getElementById("timeline-list")    as HTMLElement

function show(el: HTMLElement) { el.classList.remove("hidden") }
function hide(el: HTMLElement) { el.classList.add("hidden")    }

// ── Permalink helpers ────────────────────────────────────────────────────────

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function fromBase64Url(str: string): string {
  const pad = str.length % 4
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "")
  return atob(padded)
}

function isFlickrUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.hostname === "www.flickr.com" || u.hostname === "flickr.com") &&
           /\/photos\/[^/]+\/\d+/.test(u.pathname)
  } catch { return false }
}

function pushPermalink(flickrUrl: string): void {
  const p = toBase64Url(flickrUrl)
  history.pushState({ flickrUrl }, "", `?p=${p}`)
}

// ── Rendering ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: "UTC", timeZoneName: "short",
    })
  } catch { return iso }
}

function escHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")
}

function renderTimeline(events: TimelineEvent[]): void {
  if (events.length === 0) {
    tlList.innerHTML = `<p class="no-history">No timeline data found for this photo.</p>`
    return
  }
  tlList.innerHTML = events.map(ev => `
    <div class="timeline-event ${ev.type}">
      <div class="event-date">${formatDate(ev.date)}</div>
      <div class="event-label">
        ${ev.label}
        ${ev.archiveUrl
          ? `<a class="event-link" href="${escHtml(ev.archiveUrl)}" target="_blank" rel="noopener noreferrer" title="View archived snapshot">&#8599;</a>`
          : ""}
      </div>
      ${ev.detail ? `<div class="event-detail">${escHtml(ev.detail)}</div>` : ""}
    </div>
  `).join("")
}

function renderSources(sources: string[]): void {
  if (sources.length === 0) { hide(sourcesRow); return }
  sourcesRow.innerHTML =
    `<span>Sources:</span>` + sources.map(s => `<span class="tag">${escHtml(s)}</span>`).join("")
  show(sourcesRow)
}

// ── Search ───────────────────────────────────────────────────────────────────

async function analyze(url: string): Promise<void> {
  if (!isFlickrUrl(url)) {
    show(results)
    hide(loadingEl)
    errorBox.textContent = "Please enter a valid Flickr photo URL — e.g. https://www.flickr.com/photos/username/photo-id/"
    show(errorBox)
    hide(photoCard)
    hide(sourcesRow)
    hide(tlSection)
    return
  }

  submitBtn.disabled = true
  show(results)
  show(loadingEl)
  hide(errorBox)
  hide(photoCard)
  hide(sourcesRow)
  hide(tlSection)

  try {
    const resp = await fetch(`/.netlify/functions/analyze?url=${encodeURIComponent(url)}`)
    const data: AnalyzeResult | ErrorResult = await resp.json()

    hide(loadingEl)

    if (!resp.ok || "error" in data) {
      errorBox.textContent = "error" in data ? (data as ErrorResult).error : "Failed to analyze photo."
      show(errorBox)
      return
    }

    const result = data as AnalyzeResult

    photoThumb.src = result.thumbnailUrl ?? ""
    photoThumb.alt = result.title ?? "Photo"
    photoThumb.style.display = result.thumbnailUrl ? "" : "none"
    photoTitle.textContent  = result.title  ?? `Photo ${result.photoId}`
    photoAuthor.textContent = result.author ? `by ${result.author}` : ""
    photoLink.href          = result.photoUrl ?? url
    show(photoCard)

    renderSources(result.sources ?? [])
    renderTimeline(result.timeline ?? [])
    show(tlSection)

    pushPermalink(url)
  } catch {
    hide(loadingEl)
    errorBox.textContent = "Network error — please try again."
    show(errorBox)
  } finally {
    submitBtn.disabled = false
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const url = urlInput.value.trim()
  if (url) analyze(url)
})

// ── Permalink / page load ────────────────────────────────────────────────────

// Support both ?p=<base64url> (permalink) and ?url=<raw> (legacy / direct link)
const params = new URLSearchParams(location.search)
const pParam  = params.get("p")
const urlParam = params.get("url")

if (pParam) {
  try {
    const flickrUrl = fromBase64Url(pParam)
    urlInput.value = flickrUrl
    analyze(flickrUrl)
  } catch { /* malformed permalink — ignore */ }
} else if (urlParam) {
  urlInput.value = urlParam
  analyze(urlParam)
}
