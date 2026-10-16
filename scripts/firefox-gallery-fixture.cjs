"use strict";

// Local, deterministic media for Firefox performance and regression checks.
// No external URLs or runtime packages are used. Gallery images are lazy-loaded
// so browser image decoding does not swamp the extension work being measured.
const http = require("node:http");

const DEFAULT_PORT = 8189;
const LARGE_GALLERY_COUNT = 5000;
const SMALL_GALLERY_COUNT = 1200;
const LONG_DOM_ELEMENT_COUNT = 10500;
const WEBM = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIEEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHu7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYiFWXsjOnIN7pyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhDuaygDgkLCBQLqBMJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAxc3PWY8CLY8WIhVl7IzpyDe5nyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1w+eBAKO+gQAAgBADAJ0BKkAAMAAARwiFhYiZhIgCAgJ1qgIG5kD99CbPLgD+/43k//2eX/7PL/9nl/9nl/9x2Buu8QAcU7trkbuPs4EAt4r3gQHxggGm8IED", "base64");

function galleryPaths(count) {
  return Array.from({ length: count }, (_, index) => `/media/gallery/${String(index + 1).padStart(5, "0")}.svg`);
}

function expectations(kind, count = LARGE_GALLERY_COUNT) {
  if (kind === "long-dom") {
    return {
      kind,
      genericElementCount: LONG_DOM_ELEMENT_COUNT,
      imagePaths: [
        "/media/long/early.svg", "/media/long/background.svg", "/media/long/late.svg",
        "/media/long/lazy-original.svg", "/media/long/responsive-full.svg",
        "/media/long/poster.svg", "/media/long/shadow.svg"
      ],
      videoPaths: ["/media/long/linked.webm", "/media/long/clip.webm"],
      fullSizePath: "/media/long/lazy-original.svg",
      fullSizeDimensions: { width: 2048, height: 1536 },
      expectedWarningIncludes: "first 10,000 page elements"
    };
  }
  return { kind: "gallery", count, imagePaths: galleryPaths(count), videoPaths: [] };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function documentHtml(title, content, expected, setup = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,"><style>
body{font:16px system-ui;margin:20px;background:#edf1f5;color:#192331}h1{font-size:24px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px}
.gallery img{display:block;width:100%;height:80px;object-fit:contain;background:#d6dee8}
.background{width:120px;height:90px;background-size:contain} .filler{height:1px}
</style></head><body><h1>${escapeHtml(title)}</h1>${content}<script>
"use strict";
window.fixture = ${JSON.stringify(expected)};
window.fixture.expectedUrls = window.fixture.imagePaths.concat(window.fixture.videoPaths).map(path => new URL(path, location.href).href);
${setup}
window.fixture.ready = true;
document.documentElement.dataset.fixtureReady = "true";
</script></body></html>`;
}

function galleryHtml(count) {
  const expected = expectations("gallery", count);
  const images = expected.imagePaths.map((src, index) =>
    `<img src="${src}" data-original="${src}" data-original-width="1200" data-original-height="900" width="1200" height="900" loading="lazy" decoding="async" alt="Gallery image ${index + 1}">`
  ).join("");
  return documentHtml(`AnyDownload local gallery: ${count.toLocaleString("en-US")} images`,
    `<p>Deterministic local SVG media; all images expose their full-size URL and dimensions.</p><main class="gallery">${images}</main>`, expected);
}

function longDomHtml() {
  const placeholder = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'%3E%3C/svg%3E";
  const filler = Array.from({ length: LONG_DOM_ELEMENT_COUNT }, (_, index) => `<div class="filler" data-index="${index}"></div>`).join("");
  return documentHtml("AnyDownload long DOM regression fixture", `
<img src="/media/long/early.svg" width="120" height="90" alt="Early image">
<div class="background" style="background-image:url('/media/long/background.svg')"></div>
<a href="/media/long/linked.webm" type="video/webm">Early linked video</a><div id="early-shadow-host"></div>
${filler}<main>
<img src="/media/long/late.svg" width="120" height="90" alt="Late image">
<img src="${placeholder}" data-original="/media/long/lazy-original.svg" data-original-width="2048" data-original-height="1536" width="120" height="90" alt="Lazy full-size image">
<picture><source srcset="/media/long/responsive-small.svg 400w, /media/long/responsive-full.svg 1600w"><img src="/media/long/responsive-small.svg" width="120" height="90" alt="Responsive image"></picture>
<video src="/media/long/clip.webm" poster="/media/long/poster.svg" preload="metadata" width="64" height="48" aria-label="One second local video"></video>
</main>`, expectations("long-dom"), `
const shadowRoot = document.querySelector("#early-shadow-host").attachShadow({mode:"open"});
shadowRoot.innerHTML = '<img src="/media/long/shadow.svg" width="120" height="90" alt="Shadow image">';`);
}

function svgForPath(pathname) {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1, -4);
  const seed = [...pathname].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const width = name === "lazy-original" ? 2048 : 1200;
  const height = name === "lazy-original" ? 1536 : 900;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="hsl(${seed % 360} 50% 65%)"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="90">${escapeHtml(name)}</text></svg>`;
}

function createFixtureServer() {
  const stats = { requests: 0, imageRequests: 0, videoRequests: 0 };
  const server = http.createServer((request, response) => {
    stats.requests += 1;
    const url = new URL(request.url, "http://127.0.0.1");
    const count = Math.max(1, Math.min(LARGE_GALLERY_COUNT, Number.parseInt(url.searchParams.get("count"), 10) || LARGE_GALLERY_COUNT));
    let content;
    let contentType = "text/html; charset=utf-8";
    if (url.pathname === "/health") {
      content = JSON.stringify({ ok: true, pid: process.pid, largeGalleryCount: LARGE_GALLERY_COUNT, smallGalleryCount: SMALL_GALLERY_COUNT, longDomElementCount: LONG_DOM_ELEMENT_COUNT, stats });
      contentType = "application/json; charset=utf-8";
    } else if (url.pathname === "/expectations") {
      content = JSON.stringify(expectations(url.searchParams.get("case"), count));
      contentType = "application/json; charset=utf-8";
    } else if (url.pathname === "/" || url.pathname === "/gallery" || url.pathname === "/gallery-5000") {
      content = galleryHtml(count);
    } else if (url.pathname === "/gallery-1200") {
      content = galleryHtml(SMALL_GALLERY_COUNT);
    } else if (url.pathname === "/long-dom") {
      content = longDomHtml();
    } else if (/^\/media\/(?:gallery\/\d{5}|long\/[a-z-]+)\.svg$/.test(url.pathname)) {
      stats.imageRequests += 1;
      content = svgForPath(url.pathname);
      contentType = "image/svg+xml; charset=utf-8";
    } else if (/^\/media\/long\/(?:clip|linked)\.webm$/.test(url.pathname)) {
      stats.videoRequests += 1;
      content = WEBM;
      contentType = "video/webm";
    } else {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const media = url.pathname.startsWith("/media/");
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": media ? "public, max-age=3600" : "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(media ? { "Content-Disposition": `inline; filename="${url.pathname.split("/").pop()}"` } : {})
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
  server.fixtureStats = stats;
  return server;
}

module.exports = { createFixtureServer, expectations, galleryHtml, longDomHtml, DEFAULT_PORT };

if (require.main === module) {
  const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
  const port = Number(portArgument ? portArgument.slice(7) : process.env.FIREFOX_GALLERY_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535");
  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Firefox gallery fixture: http://127.0.0.1:${port}/gallery-5000`);
    console.log(`Small gallery: http://127.0.0.1:${port}/gallery-1200`);
    console.log(`Long DOM regressions: http://127.0.0.1:${port}/long-dom`);
  });
}
