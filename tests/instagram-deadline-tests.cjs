"use strict";

const assert = require("assert").strict;
const Instagram = require("../extension/shared/instagram.js");
const collectFromPage = new Function(`return (${Instagram.collectFromPage.toString()});`)();

function jsonResponse(url, value) {
  return { ok: true, url, headers: { get(name) {
    return name === "content-type" ? "application/json" : null;
  } }, async text() { return JSON.stringify(value); } };
}

async function fixture({ url, payload, anchors = [], options, elapsedBeforeFetch = 0, fetchValue,
  expireDuringFetch = false }) {
  const startedAt = 1000000;
  let now = startedAt;
  const timers = [];
  const clearedTimers = [];
  const requests = [];
  const script = {
    textContent: JSON.stringify(payload),
    getAttribute(name) { return name === "type" ? "application/json" : null; }
  };
  const document = { title: "Deadline fixture", cookie: "",
    querySelectorAll(selector) {
      if (selector === "script") {
        now = startedAt + elapsedBeforeFetch;
        return [script];
      }
      if (selector === "a[href]") return anchors.map((href) => ({
        getAttribute(name) { return name === "href" ? href : null; },
        querySelectorAll() { return []; }
      }));
      return [];
    }
  };
  const replacements = {
    document, location: { href: url }, window: { self: null, top: null },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { clearedTimers.push(timer); },
    async fetch(requestUrl, init) {
      requests.push({ url: requestUrl, signal: init.signal });
      if (expireDuringFetch) now = startedAt + 120000;
      return jsonResponse(requestUrl, fetchValue);
    }
  };
  replacements.window.self = replacements.window;
  replacements.window.top = replacements.window;
  const savedNow = Object.getOwnPropertyDescriptor(Date, "now");
  const savedGlobals = new Map();
  Object.defineProperty(Date, "now", { configurable: true, writable: true, value: () => now });
  for (const [name, value] of Object.entries(replacements)) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return { result: await collectFromPage({ maxItems: 1500, maxDocuments: 512, ...options }),
      requests, timers, clearedTimers };
  } finally {
    Object.defineProperty(Date, "now", savedNow);
    for (const [name, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function run() {
  const partial = { code: "DEADLINE1", user: { pk: "42", username: "alice" },
    media_type: 8, carousel_media_count: 2, carousel_media: [{
      id: "kept", media_type: 1, image_versions2: { candidates: [{
        url: "https://scontent.cdninstagram.com/kept.jpg", width: 1080, height: 1350
      }] }
    }] };

  // A response arriving at the deadline remains usable. It must not start
  // another timeline page, reels traversal, or individual-post recovery.
  const profile = await fixture({
    url: "https://www.instagram.com/alice/", payload: { user: partial.user },
    options: { includeProfileReels: true }, elapsedBeforeFetch: 119500,
    expireDuringFetch: true,
    fetchValue: { items: [partial], more_available: true, next_max_id: "NEXT-PAGE" }
  });
  assert.equal(profile.requests.length, 1);
  assert.match(profile.requests[0].url, /\/api\/v1\/feed\/user\/42\//);
  assert.deepEqual(profile.result.images.map(({ url }) => url), [
    "https://scontent.cdninstagram.com/kept.jpg"
  ]);
  assert.equal(profile.result.profileCollection.complete, false);
  assert.ok(profile.result.warnings.some((warning) => /2-minute safety limit/.test(warning)));
  assert.ok(profile.result.warnings.some((warning) => /full post history could not be read/.test(warning)));
  assert.deepEqual(profile.timers.map(({ delay }) => delay), [500],
    "An in-flight request may use only the remaining collection time");
  assert.deepEqual(profile.clearedTimers, profile.timers);
  assert.ok(profile.requests[0].signal instanceof AbortSignal);

  // The same deadline must suppress GraphQL and HTML fallbacks on an exact
  // post, rather than granting those retries their own collection lifetime.
  const post = await fixture({
    url: "https://www.instagram.com/p/DEADLINE1/", payload: { shortcode_media: partial },
    options: {}, elapsedBeforeFetch: 119500, expireDuringFetch: true,
    fetchValue: { items: [partial] }
  });
  assert.equal(post.requests.length, 1);
  assert.match(post.requests[0].url, /\/api\/v1\/media\/\d+\/info\//);
  assert.equal(post.result.images[0].url, "https://scontent.cdninstagram.com/kept.jpg");
  assert.ok(post.result.warnings.some((warning) => /2-minute safety limit/.test(warning)));
  assert.deepEqual(post.timers.map(({ delay }) => delay), [500]);
  assert.deepEqual(post.clearedTimers, post.timers);

  // The expanded history budget is confined to profile posts. A stories and
  // highlights operation still has the original 32-request bound even when
  // its caller requests the larger account-history budget.
  const related = await fixture({
    url: "https://www.instagram.com/alice/", payload: { user: partial.user },
    anchors: Array.from({ length: 40 }, (_, index) => `/stories/highlights/${1000 + index}/`),
    options: { includeProfilePosts: false, includeStories: true, includeHighlights: true },
    fetchValue: {}
  });
  assert.equal(related.requests.length, 32);
  assert.ok(related.result.warnings.some((warning) => /bounded document/.test(warning)));
  assert.ok(!related.result.warnings.some((warning) => /2-minute safety limit/.test(warning)));
  console.log("Instagram deadline tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
