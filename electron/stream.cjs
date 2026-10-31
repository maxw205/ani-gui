// Lets the page's <video> play the streams ani-cli finds.
//
// The stream hosts only answer requests that carry the referrer of the site the link came
// from, and a page can't set that header. So the page asks for anistream://proxy/?u=<url>
// instead; this fetches <url> with the referrer and passes the answer back. HLS playlists
// are rewritten so the segments (and keys, subtitles) they list go through here too.
// Only hosts ani-cli handed over (or that their playlists point at) are fetched.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const proxyUrl = (url) => `anistream://proxy/?u=${encodeURIComponent(url)}`;

class StreamProxy {
  constructor() {
    this.referrers = new Map(); // host -> referrer to send
  }

  /** Lets the page fetch `url` (sent with `referrer`); returns the URL the page should use. */
  allow(url, referrer) {
    try {
      this.referrers.set(new URL(url).host, referrer);
    } catch {
      // not a URL; the request will fail on its own
    }
    return proxyUrl(url);
  }

  /** protocol.handle("anistream", ...) */
  async handle(request) {
    const cors = { "Access-Control-Allow-Origin": "*" };
    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get("u"));
    } catch {
      return new Response("bad stream url", { status: 400, headers: cors });
    }
    const referrer = this.referrers.get(target.host);
    if (target.protocol !== "https:" || referrer === undefined) {
      return new Response("stream host not allowed", { status: 403, headers: cors });
    }

    const headers = { "User-Agent": USER_AGENT, Referer: referrer };
    const range = request.headers.get("range");
    if (range) headers.Range = range;
    let upstream;
    try {
      upstream = await fetch(target, { headers });
    } catch (err) {
      return new Response(`stream fetch failed: ${err.message}`, { status: 502, headers: cors });
    }
    if (!upstream.ok) return new Response(null, { status: upstream.status, headers: cors });

    const type = upstream.headers.get("content-type") || "";
    if (target.pathname.endsWith(".m3u8") || type.includes("mpegurl")) {
      const playlist = this.rewritePlaylist(await upstream.text(), target, referrer);
      return new Response(playlist, { headers: { ...cors, "Content-Type": "application/vnd.apple.mpegurl" } });
    }
    const out = { ...cors, "Content-Type": target.pathname.endsWith(".vtt") ? "text/vtt" : type || "application/octet-stream" };
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  /** Points every URI in an HLS playlist (segment lines and URI="..." attributes) at the proxy. */
  rewritePlaylist(text, base, referrer) {
    const through = (uri) => this.allow(new URL(uri, base).href, referrer);
    return text
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${through(uri)}"`);
        return through(line.trim());
      })
      .join("\n");
  }
}

module.exports = { StreamProxy };
