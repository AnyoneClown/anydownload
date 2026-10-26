"use strict";

const assert = require("assert").strict;
const Instagram = require("../extension/shared/instagram.js");

// executeScript serializes the function without its module closure.
const collectFromPage = new Function(`return (${Instagram.collectFromPage.toString()});`)();

async function scanRuntimeProfile({ maxItems = 1500, includeProfilePosts = true,
  posts: suppliedPosts, feedItems = [] } = {}) {
  const user = { pk: "42", username: "alice" };
  const photo = (id) => ({ id, media_type: 1,
    image_versions2: { candidates: [{
      url: `https://scontent.cdninstagram.com/${id}.jpg`, width: 1080, height: 1350
    }] }
  });
  const posts = suppliedPosts || Array.from({ length: 150 }, (_, index) => ({
    code: `RUNTIME${index}`, user, media_type: 8, carousel_media_count: 2,
    carousel_media: [photo(`photo${index}a`), photo(`photo${index}b`)]
  }));
  const root = {
    querySelectorAll() { return []; },
    __reactProps$fixture: { children: { posts: [
      ...posts,
      { code: "FOREIGN", user: { pk: "99", username: "bob" }, ...photo("foreign") },
      { code: "OWNERLESS", ...photo("ownerless") }
    ] } }
  };
  // Real React fibers contain cycles. They must not prevent bounded traversal.
  root.__reactProps$fixture.parent = root.__reactProps$fixture;
  const script = {
    textContent: JSON.stringify({ user }),
    getAttribute(name) { return name === "type" ? "application/json" : null; }
  };
  const anchors = posts.map(({ code }) => ({
    getAttribute(name) { return name === "href" ? `/alice/p/${code}/` : null; },
    querySelectorAll() { return []; }
  }));
  const requests = [];
  const replacements = {
    location: { href: "https://www.instagram.com/alice/" },
    document: {
      title: "Runtime profile", cookie: "", body: root, documentElement: root,
      querySelectorAll(selector) {
        if (selector === "script") return [script];
        if (selector === "a[href]") return anchors;
        if (["main", "body", "*"].includes(selector)) return [root];
        return [];
      }
    },
    window: { self: null, top: null },
    fetch: async (url) => {
      requests.push(url);
      const text = JSON.stringify({ items: feedItems, more_available: false });
      return { ok: true, url, headers: { get(name) {
        return name === "content-type" ? "application/json" : null;
      } }, async text() { return text; } };
    }
  };
  replacements.window.self = replacements.window;
  replacements.window.top = replacements.window;
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return { result: await collectFromPage({ includeProfilePosts,
      includeProfileReels: false, maxItems, maxDocuments: 32 }), requests };
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function run() {
  const { result, requests } = await scanRuntimeProfile();
  assert.equal(result.images.length, 300,
    "A known profile pk must not hide complete loaded React carousel media");
  assert.deepEqual(result.images.map(({ url }) => url), Array.from({ length: 150 }, (_, index) => [
    `https://scontent.cdninstagram.com/photo${index}a.jpg`,
    `https://scontent.cdninstagram.com/photo${index}b.jpg`
  ]).flat());
  assert.deepEqual(result.profileCollection, { username: "alice", posts: 150, complete: true });
  assert.deepEqual(result.warnings, []);
  assert.equal(requests.length, 1, "Resolved runtime posts need no individual network lookups");
  assert.match(requests[0], /\/api\/v1\/feed\/user\/42\//);

  // Runtime data can expose the full video-first carousel before the feed
  // returns its photo cover or a partial child list. Neither response may
  // replace a resolved MP4 with its poster while retaining the video label.
  // A later complete feed may still refresh all signed source URLs.
  {
    const photo = (id) => ({ id, media_type: 1, image_versions2: { candidates: [{
      url: `https://scontent.cdninstagram.com/${id}.jpg`, width: 1080, height: 1350
    }] } });
    const video = (id) => ({ id, media_type: 2, video_versions: [{
      url: `https://scontent.cdninstagram.com/${id}.mp4`, width: 1080, height: 1350
    }] });
    const carousel = { code: "RUNTIMEVIDEO", user: { pk: "42", username: "alice" },
      media_type: 8, carousel_media_count: 3,
      carousel_media: [video("original-first"), photo("original-second"), photo("original-third")]
    };
    const completeFeed = { ...carousel,
      carousel_media: [video("fresh-first"), photo("fresh-second"), photo("fresh-third")]
    };
    const feeds = {
      cover: { ...photo("feed-cover"), code: carousel.code, user: carousel.user,
        media_type: 8, carousel_media_count: 3 },
      partial: { ...carousel, carousel_media: [photo("first-poster"), photo("partial-second"),
        { id: "missing-third", media_type: 1 }] },
      complete: completeFeed,
      foreign: { ...completeFeed, user: { pk: "99", username: "bob" } }
    };
    for (const [kind, feed] of Object.entries(feeds)) {
      const scanned = await scanRuntimeProfile({ posts: [carousel], feedItems: [feed] });
      const expectedPrefix = kind === "complete" ? "fresh" : "original";
      assert.deepEqual(scanned.result.images.map(({ url, mediaType }) => ({ url, mediaType })), [
        { url: `https://scontent.cdninstagram.com/${expectedPrefix}-first.mp4`, mediaType: "video" },
        { url: `https://scontent.cdninstagram.com/${expectedPrefix}-second.jpg`, mediaType: "image" },
        { url: `https://scontent.cdninstagram.com/${expectedPrefix}-third.jpg`, mediaType: "image" }
      ], kind);
      assert.deepEqual(scanned.result.profileCollection,
        { username: "alice", posts: 1, complete: true }, kind);
      assert.deepEqual(scanned.result.warnings, [], kind);
      assert.equal(scanned.requests.length, 1, kind);
    }
  }

  const bounded = await scanRuntimeProfile({ maxItems: 3 });
  assert.equal(bounded.result.images.length, 3);
  assert.equal(bounded.result.profileCollection.complete, false);
  assert.ok(bounded.result.warnings.some((warning) => /3-item safety limit/.test(warning)));
  assert.ok(bounded.requests.length <= 32, "Runtime extraction preserves the network request bound");

  const disabled = await scanRuntimeProfile({ includeProfilePosts: false });
  assert.equal(disabled.result.images.length, 0);
  assert.equal(disabled.requests.length, 0, "Stories-only collection must not inspect profile post media");
  console.log("Instagram runtime profile tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
