"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const Instagram = require("../extension/shared/instagram.js");

assert.equal(typeof Instagram, "object");
assert.equal(typeof Instagram.isInstagramUrl, "function");
assert.equal(typeof Instagram.canCollectRelated, "function");
assert.equal(typeof Instagram.routeKeyForUrl, "function");
assert.equal(typeof Instagram.collectFromPage, "function");

assert.equal(Instagram.isInstagramUrl("https://www.instagram.com/p/ABC123/"), true);
assert.equal(Instagram.isInstagramUrl("https://m.instagram.com/stories/alice/123/"), true);
assert.equal(Instagram.isInstagramUrl("http://instagram.com/reel/ABC123/"), true);
assert.equal(Instagram.isInstagramUrl("https://help.instagram.com/stories/alice/123/"), false);
assert.equal(Instagram.isInstagramUrl("https://instagram.com.evil.test/p/ABC123/"), false);
assert.equal(Instagram.isInstagramUrl("https://cdninstagram.com/file.mp4"), false);
assert.equal(Instagram.isInstagramUrl("javascript:alert(1)"), false);
assert.equal(Instagram.canCollectRelated("https://www.instagram.com/alice/"), true);
assert.equal(Instagram.canCollectRelated("https://www.instagram.com/p/ABC123/"), false);
assert.equal(Instagram.canCollectRelated("https://www.instagram.com/explore/"), false);
assert.equal(Instagram.canCollectRelated("https://www.instagram.com/accounts/login/"), false);
assert.equal(
  Instagram.routeKeyForUrl("https://www.instagram.com/alice/"),
  "instagram:profile:alice"
);
assert.equal(
  Instagram.routeKeyForUrl("https://www.instagram.com/p/ABC123/?img_index=2"),
  "instagram:post:ABC123"
);
assert.equal(
  Instagram.routeKeyForUrl("https://www.instagram.com/alice/reel/REEL123/"),
  "instagram:reel:REEL123"
);
assert.equal(
  Instagram.routeKeyForUrl("https://www.instagram.com/stories/alice/456/"),
  "instagram:story:alice:456"
);
assert.equal(
  Instagram.routeKeyForUrl("https://www.instagram.com/stories/highlights/987/"),
  "instagram:highlight:987"
);
assert.equal(Instagram.routeKeyForUrl("https://www.instagram.com/explore/"), "");
assert.equal(Instagram.routeKeyForUrl("https://www.instagram.com/explore/p/ABC123/"), "");

// Firefox serializes executeScript.func without its module closure. All
// behavior tests use the same standalone form that Firefox executes.
const collectFromPage = new Function(`return (${Instagram.collectFromPage.toString()});`)();

function script(value, type = "application/json", raw = false) {
  const text = raw ? String(value) : JSON.stringify(value);
  return {
    textContent: text,
    innerText: text,
    getAttribute(name) {
      return String(name).toLowerCase() === "type" ? type : null;
    }
  };
}

function anchor(href) {
  return {
    href,
    getAttribute(name) {
      return String(name).toLowerCase() === "href" ? href : null;
    }
  };
}

function meta(property, content) {
  return {
    getAttribute(name) {
      const normalized = String(name).toLowerCase();
      if (normalized === "property" || normalized === "name") {
        return property;
      }
      return normalized === "content" ? content : null;
    }
  };
}

function fakeDocument({ scripts = [], anchors = [], metas = [], title = "Instagram fixture" } = {}) {
  return {
    title,
    querySelectorAll(selector) {
      if (selector === "script") {
        return scripts;
      }
      if (selector === "a[href]") {
        return anchors;
      }
      if (selector === "meta[property], meta[name]") {
        return metas;
      }
      return [];
    }
  };
}

function response(url, html, options = {}) {
  const headers = Object.assign({
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html))
  }, options.headers || {});
  return {
    ok: options.ok !== false,
    status: options.ok === false ? 403 : 200,
    url,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      }
    },
    async text() {
      return html;
    }
  };
}

function jsonResponse(url, value, options = {}) {
  return response(url, JSON.stringify(value), {
    ...options,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
}

function htmlDocument({ scripts = [], anchors = [], metas = [] } = {}) {
  const escapedAttribute = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return [
    "<!doctype html><html><head>",
    ...metas.map((item) =>
      `<meta property="${escapedAttribute(item.property)}" content="${escapedAttribute(item.content)}">`),
    ...scripts.map((item) =>
      `<script type="${escapedAttribute(item.type || "application/json")}">${item.raw ? item.value : JSON.stringify(item.value)}</script>`),
    "</head><body>",
    ...anchors.map((href) => `<a href="${escapedAttribute(href)}">collection</a>`),
    "</body></html>"
  ].join("");
}

async function withPage(url, page, callback, fetchImpl) {
  const replacements = {
    location: { href: url },
    document: fakeDocument(page),
    window: null
  };
  replacements.window = { self: null, top: null };
  replacements.window.self = replacements.window;
  replacements.window.top = replacements.window;
  if (fetchImpl !== undefined) {
    replacements.fetch = fetchImpl;
  }
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, {
      existed: Object.prototype.hasOwnProperty.call(globalThis, name),
      value: globalThis[name]
    });
    globalThis[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, oldValue] of previous) {
      if (oldValue.existed) {
        globalThis[name] = oldValue.value;
      } else {
        delete globalThis[name];
      }
    }
  }
}

async function scan(url, page, options = {}, fetchImpl) {
  return withPage(url, page, () => collectFromPage({
    includeRelated: false,
    maxItems: 1500,
    maxDocuments: 32,
    maxDocumentBytes: 4000000,
    maxTotalDocumentBytes: 32000000,
    maxPayloadLength: 2000000,
    ...options
  }), fetchImpl);
}

function imageNode(id, url, width = 1080, height = 1350) {
  return {
    id,
    is_video: false,
    dimensions: { width, height },
    display_resources: [
      { src: `${url}?size=small`, config_width: 320, config_height: 400, width: 320, height: 400 },
      { src: url, config_width: width, config_height: height, width, height }
    ]
  };
}

function videoNode(id, url, poster, width = 1080, height = 1920) {
  return {
    id,
    is_video: true,
    dimensions: { width, height },
    video_duration: 12.5,
    video_versions: [
      { url: `${url}?quality=low`, width: 360, height: 640, bitrate: 300000 },
      { url, width, height, bitrate: 2400000 }
    ],
    display_resources: [
      { src: `${poster}?size=small`, width: 270, height: 480 },
      { src: poster, width, height }
    ]
  };
}

async function run() {
  // Unsupported Instagram pages fall back to the generic DOM collector, while
  // profile routes are owned by the Instagram adapter even when the feed is empty.
  {
    const unsupported = await scan("https://www.instagram.com/explore/", {});
    assert.equal(unsupported.handled, false);
    const reservedPrefixed = await scan("https://www.instagram.com/explore/p/ABC123/", {});
    assert.equal(reservedPrefixed.handled, false);
    const requests = [];
    const profile = await scan("https://www.instagram.com/alice/", {
      scripts: [script({ data: { user: { pk: "42", username: "alice" } } })]
    }, {}, async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(url, { items: [], more_available: false });
    });
    assert.equal(profile.handled, true);
    assert.equal(profile.images.length, 0);
    assert.ok(profile.warnings.some((warning) => /profile posts/i.test(warning)));
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/v1\/feed\/user\/42\/?\?count=12$/);
  }

  // Profile feeds are paged with the signed-in session. Every carousel child
  // is kept in source order and media owned by another account is rejected.
  {
    const requests = [];
    const firstCarousel = {
      code: "FEED2",
      user: { username: "alice" },
      carousel_media: [
        imageNode("feed-2-a", "https://scontent.cdninstagram.com/feed-2-a.jpg"),
        imageNode("feed-2-b", "https://scontent.cdninstagram.com/feed-2-b.jpg")
      ]
    };
    const result = await scan("https://www.instagram.com/alice/", {
      scripts: [script({ data: { user: { pk: "42", username: "alice" } } })]
    }, {}, async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/api/v1/feed/user/42/");
      assert.equal(parsed.searchParams.get("count"), "12");
      if (!parsed.searchParams.has("max_id")) {
        return jsonResponse(url, {
          items: [
            {
              code: "FEED1",
              user: { username: "alice" },
              ...imageNode("feed-1", "https://scontent.cdninstagram.com/feed-1.jpg")
            },
            firstCarousel,
            {
              code: "OTHER1",
              user: { username: "bob" },
              ...imageNode("other-1", "https://scontent.cdninstagram.com/not-alice.jpg")
            }
          ],
          more_available: true,
          next_max_id: "CURSOR-2"
        });
      }
      assert.equal(parsed.searchParams.get("max_id"), "CURSOR-2");
      return jsonResponse(url, {
        items: [{
          code: "FEED3",
          user: { username: "alice" },
          ...imageNode("feed-3", "https://scontent.cdninstagram.com/feed-3.jpg")
        }],
        more_available: false
      });
    });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/feed-1.jpg",
      "https://scontent.cdninstagram.com/feed-2-a.jpg",
      "https://scontent.cdninstagram.com/feed-2-b.jpg",
      "https://scontent.cdninstagram.com/feed-3.jpg"
    ]);
    assert.deepEqual(result.images.map((item) => item.instagramCollections[0].id), [
      "FEED1", "FEED2", "FEED2", "FEED3"
    ]);
    assert.ok(result.images.every((item) =>
      item.instagramCollections[0].type === "post" &&
      item.instagramCollections[0].owner === "alice"
    ));
    assert.equal(requests.length, 2, "Pagination must stop after more_available becomes false");
    assert.ok(requests.every((item) => item.init.credentials === "include"));
    assert.ok(requests.every((item) =>
      item.init.headers["X-IG-App-ID"] === "936619743392459"
    ));
  }

  // If hydration omits the user pk, web_profile_info supplies both the pk and
  // any initial timeline data before normal feed traversal begins.
  {
    const requests = [];
    const result = await scan("https://www.instagram.com/alice/", {}, {}, async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/users/web_profile_info/") {
        assert.equal(parsed.searchParams.get("username"), "alice");
        return jsonResponse(url, { data: { user: {
          id: "55",
          username: "alice",
          edge_owner_to_timeline_media: { edges: [{ node: {
            shortcode: "INITIAL1",
            owner: { username: "alice" },
            ...imageNode("initial-1", "https://scontent.cdninstagram.com/initial-1.jpg")
          } }] }
        } } });
      }
      assert.equal(parsed.pathname, "/api/v1/feed/user/55/");
      return jsonResponse(url, { items: [], more_available: false });
    });
    assert.deepEqual(requests.map((item) => new URL(item.url).pathname), [
      "/api/v1/users/web_profile_info/",
      "/api/v1/feed/user/55/"
    ]);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/initial-1.jpg"
    ]);
    assert.equal(result.images[0].instagramCollections[0].id, "INITIAL1");
    assert.ok(requests.every((item) => item.init.credentials === "include"));
  }

  // Route matching keeps the active post and rejects unrelated recommendations.
  {
    let fetchCount = 0;
    const active = {
      shortcode: "POST123",
      owner: { username: "alice" },
      accessibility_caption: "Alice's post",
      ...imageNode("1", "https://scontent.cdninstagram.com/post-large.jpg", 1440, 1800)
    };
    const unrelated = {
      shortcode: "OTHER999",
      owner: { username: "mallory" },
      ...imageNode("2", "https://scontent.cdninstagram.com/recommendation.jpg")
    };
    const result = await scan("https://www.instagram.com/p/POST123/", {
      scripts: [script({ data: { xdt_shortcode_media: active }, suggested: unrelated })]
    }, {
      includeRelated: true,
      includeStories: true,
      includeHighlights: true
    }, async () => {
      fetchCount += 1;
      throw new Error("Exact post routes must never fetch related collections.");
    });
    assert.equal(result.handled, true);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/post-large.jpg");
    assert.equal(result.images[0].previewUrl, "https://scontent.cdninstagram.com/post-large.jpg?size=small");
    assert.equal(result.images[0].width, 1440);
    assert.equal(result.images[0].height, 1800);
    assert.equal(result.images[0].alt, "Alice's post");
    assert.equal(result.images[0].mediaType, "image");
    assert.equal(fetchCount, 0);
    assert.deepEqual(result.images[0].instagramCollections, [{
      type: "post",
      id: "POST123",
      title: "",
      owner: "alice"
    }]);
  }

  // Every sidecar child is emitted once and in source order regardless of the
  // current img_index. Progressive video selection prefers the largest variant.
  {
    const carousel = {
      shortcode: "CAROUSEL1",
      owner: { username: "alice" },
      edge_sidecar_to_children: {
        edges: [
          { node: { ...imageNode("POLARIS_11", "https://scontent.cdninstagram.com/slide-1.jpg"), pk: "11" } },
          { node: { ...videoNode(
            "12",
            "https://scontent.cdninstagram.com/slide-2.mp4",
            "https://scontent.cdninstagram.com/slide-2-poster.jpg"
          ), id: "POLARIS_12", pk: "12" } },
          { node: { ...imageNode("POLARIS_13", "https://scontent.cdninstagram.com/slide-3.webp"), pk: "13" } }
        ]
      }
    };
    const result = await scan(
      "https://www.instagram.com/p/CAROUSEL1/?img_index=2",
      { scripts: [script({ graphql: { shortcode_media: carousel } })] }
    );
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/slide-1.jpg",
      "https://scontent.cdninstagram.com/slide-2.mp4",
      "https://scontent.cdninstagram.com/slide-3.webp"
    ]);
    assert.equal(result.images[1].mediaType, "video");
    assert.equal(result.images[1].mimeType, "video/mp4");
    assert.equal(result.images[1].duration, 12.5);
    assert.equal(
      result.images[1].previewUrl,
      "https://scontent.cdninstagram.com/slide-2-poster.jpg?size=small"
    );
    assert.deepEqual(result.images.map((item) => item.kinds[0]), [
      "Instagram carousel 1/3 image",
      "Instagram carousel 2/3 video",
      "Instagram carousel 3/3 image"
    ]);
  }

  // Modern web-info payloads expose reel items through image_versions2 and
  // video_versions rather than the legacy GraphQL display fields.
  {
    const result = await scan("https://www.instagram.com/reel/REEL777/", {
      scripts: [script({
        data: {
          xdt_api__v1__media__shortcode__web_info: {
            items: [{
              code: "REEL777",
              media_type: 2,
              user: { username: "alice" },
              image_versions2: {
                candidates: [
                  { url: "https://scontent.cdninstagram.com/reel-poster-small.jpg", width: 360, height: 640 },
                  { url: "https://scontent.cdninstagram.com/reel-poster.jpg", width: 1080, height: 1920 }
                ]
              },
              video_versions: [
                { url: "https://scontent.cdninstagram.com/reel-small.mp4", width: 360, height: 640 },
                { url: "https://scontent.cdninstagram.com/reel.mp4", width: 1080, height: 1920 }
              ]
            }, {
              code: "UNRELATED",
              media_type: 1,
              image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/no.jpg" }] }
            }]
          }
        }
      })]
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/reel.mp4");
    assert.equal(result.images[0].mediaType, "video");
  }

  // Active stories are matched by owner and expanded to every ordered frame;
  // another account's prefetched reel is excluded.
  {
    const result = await scan("https://www.instagram.com/stories/alice/102/", {
      scripts: [script({ reels_media: [{
        id: "alice-reel",
        user: { username: "alice" },
        items: [
          { ...imageNode("101", "https://scontent.cdninstagram.com/story-1.jpg"), user: { username: "alice" } },
          { ...videoNode(
            "102",
            "https://scontent.cdninstagram.com/story-2.mp4",
            "https://scontent.cdninstagram.com/story-2-poster.jpg"
          ), user: { username: "alice" } }
        ]
      }, {
        id: "bob-reel",
        user: { username: "bob" },
        items: [imageNode("201", "https://scontent.cdninstagram.com/bob-story.jpg")]
      }] })]
    });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/story-1.jpg",
      "https://scontent.cdninstagram.com/story-2.mp4"
    ]);

    const foreignDirectItem = await scan("https://www.instagram.com/stories/alice/102/", {
      scripts: [script({
        ...imageNode("102", "https://scontent.cdninstagram.com/wrong-direct-story.jpg"),
        user: { username: "bob" }
      })]
    });
    assert.equal(
      foreignDirectItem.images.length,
      0,
      "A direct story-item fallback must not bypass the requested owner scope"
    );
  }

  // Highlight dictionaries commonly key reels as "highlight:<id>". The
  // adapter matches that exact route ID and preserves the highlight frame order.
  {
    const result = await scan("https://www.instagram.com/stories/highlights/987654/", {
      scripts: [script({ reels: {
        "highlight:987654": {
          id: "highlight:987654",
          items: [
            imageNode("301", "https://scontent.cdninstagram.com/highlight-1.jpg"),
            imageNode("302", "https://scontent.cdninstagram.com/highlight-2.jpg")
          ]
        },
        "highlight:111111": {
          id: "highlight:111111",
          items: [imageNode("303", "https://scontent.cdninstagram.com/wrong-highlight.jpg")]
        }
      } })]
    });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/highlight-1.jpg",
      "https://scontent.cdninstagram.com/highlight-2.jpg"
    ]);
  }

  // JSON assignment/callback wrappers are parsed as data, never evaluated.
  {
    const payload = {
      graphql: {
        shortcode_media: {
          shortcode: "WRAPPED1",
          ...imageNode("401", "https://scontent.cdninstagram.com/wrapped.jpg")
        }
      }
    };
    const result = await scan("https://www.instagram.com/p/WRAPPED1/", {
      scripts: [script(
        `window.__additionalDataLoaded('/p/WRAPPED1/', ${JSON.stringify(payload)});`,
        "text/javascript",
        true
      )]
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/wrapped.jpg");
  }

  // Route-scoped JSON-LD is a safe fallback when Instagram omits its internal
  // hydration shape. Direct schema.org video plus its thumbnail is supported.
  {
    const result = await scan("https://www.instagram.com/reel/LDJSON1/", {
      scripts: [script({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        contentUrl: "https://scontent.cdninstagram.com/ld-video.mp4",
        thumbnailUrl: "https://scontent.cdninstagram.com/ld-poster.jpg",
        width: 1080,
        height: 1920,
        description: "Schema reel"
      }, "application/ld+json")]
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/ld-video.mp4");
    assert.equal(result.images[0].mediaType, "video");
  }

  // OpenGraph data is accepted only as a route-scoped fallback.
  {
    const result = await scan("https://www.instagram.com/p/META123/", {
      metas: [
        meta("og:url", "https://www.instagram.com/p/META123/"),
        meta("og:image", "https://scontent.cdninstagram.com/meta.jpg"),
        meta("og:image:width", "1200"),
        meta("og:image:height", "1500"),
        meta("og:description", "Meta post")
      ]
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/meta.jpg");
    assert.equal(result.images[0].width, 1200);
  }

  // Explicit profile collections use session-authenticated first-party APIs,
  // keep story/highlight metadata, and can omit profile posts for popup merging.
  {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/highlights/42/highlights_tray/") {
        return jsonResponse(url, { tray: [
          {
            id: "highlight:777",
            title: "Trips",
            user: { username: "alice" }
          },
          {
            id: "highlight:888",
            title: "Other account",
            user: { username: "bob" }
          }
        ] });
      }
      if (parsed.pathname === "/api/v1/feed/reels_media/" &&
        parsed.searchParams.get("reel_ids") === "42") {
        return jsonResponse(url, { reels: { "42": {
          id: "42",
          user: { username: "alice" },
          items: [
            imageNode("501", "https://scontent.cdninstagram.com/related-story.jpg"),
            {
              ...imageNode("502", "https://scontent.cdninstagram.com/wrong-owner-story.jpg"),
              user: { username: "bob" }
            }
          ]
        } } });
      }
      if (parsed.pathname === "/api/v1/feed/reels_media/" &&
        parsed.searchParams.get("reel_ids") === "highlight:777") {
        return jsonResponse(url, { reels: { "highlight:777": {
          id: "highlight:777",
          title: "Trips",
          user: { username: "alice" },
          items: [
            imageNode("shared-highlight", "https://scontent.cdninstagram.com/related-story.jpg"),
            videoNode(
              "601",
              "https://scontent.cdninstagram.com/related-highlight.mp4",
              "https://scontent.cdninstagram.com/related-highlight.jpg"
            )
          ]
        } } });
      }
      return jsonResponse(url, {}, { ok: false });
    };
    const result = await scan("https://www.instagram.com/alice/", {
      scripts: [script({ data: { user: { pk: "42", username: "alice" } } })]
    }, { includeRelated: true, includeProfilePosts: false }, fetchImpl);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/related-story.jpg",
      "https://scontent.cdninstagram.com/related-highlight.mp4"
    ]);
    assert.deepEqual(result.images[0].instagramCollections, [
      {
        type: "story",
        id: "alice",
        title: "",
        owner: "alice"
      },
      {
        type: "highlight",
        id: "777",
        title: "Trips",
        owner: "alice"
      }
    ]);
    assert.deepEqual(result.images[1].instagramCollections, [{
      type: "highlight",
      id: "777",
      title: "Trips",
      owner: "alice"
    }]);
    assert.deepEqual(requests.map((item) => new URL(item.url).pathname), [
      "/api/v1/highlights/42/highlights_tray/",
      "/api/v1/feed/reels_media/",
      "/api/v1/feed/reels_media/"
    ]);
    assert.ok(requests.every((item) => item.init.credentials === "include"));
    assert.ok(requests.every((item) => item.init.method === "GET"));
    assert.ok(requests.every((item) =>
      item.init.headers["X-IG-App-ID"] === "936619743392459"
    ));
  }

  // HTML anchor fallbacks keep the originating profile owner and collection
  // ID across redirects instead of accepting another account's media.
  {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/users/web_profile_info/") {
        return jsonResponse(url, {}, { ok: false });
      }
      if (parsed.pathname === "/stories/alice/123/") {
        return response(
          "https://www.instagram.com/stories/bob/999/",
          htmlDocument({ scripts: [{ value: { reels_media: [{
            id: "bob-reel",
            user: { username: "bob" },
            items: [imageNode("901", "https://scontent.cdninstagram.com/wrong-redirect-story.jpg")]
          }] } }] })
        );
      }
      if (parsed.pathname === "/stories/highlights/777/") {
        return response(
          "https://www.instagram.com/stories/highlights/888/",
          htmlDocument({ scripts: [{ value: { reels: {
            "highlight:888": {
              id: "highlight:888",
              user: { username: "bob" },
              items: [imageNode("902", "https://scontent.cdninstagram.com/wrong-redirect-highlight.jpg")]
            }
          } } }] })
        );
      }
      return response(url, "", { ok: false });
    };
    const result = await scan("https://www.instagram.com/alice/", {
      anchors: [
        anchor("/stories/alice/123/"),
        anchor("/stories/highlights/777/")
      ]
    }, {
      includeProfilePosts: false,
      includeStories: true,
      includeHighlights: true
    }, fetchImpl);
    assert.equal(result.images.length, 0);
    assert.ok(result.warnings.some((warning) => /unavailable/i.test(warning)));
  }

  // Username-prefixed post links are still exact post scopes and never fetch.
  {
    let fetchCount = 0;
    const result = await scan("https://www.instagram.com/alice/p/OWNERPOST/", {
      scripts: [script({ shortcode_media: {
        shortcode: "OWNERPOST",
        owner: { username: "alice" },
        ...imageNode("701", "https://scontent.cdninstagram.com/current-post.jpg")
      } })]
    }, { includeRelated: true }, async (url) => {
      fetchCount += 1;
      return jsonResponse(url, {}, { ok: false });
    });
    assert.equal(fetchCount, 0);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/current-post.jpg"
    ]);
  }

  // Stable-ID normalization must not collapse distinct carousel/story frames.
  {
    const result = await scan("https://www.instagram.com/stories/highlights/4242/", {
      scripts: [script({ reels: {
        "highlight:4242": {
          id: "highlight:4242",
          items: [
            imageNode("shared_100", "https://scontent.cdninstagram.com/shared.jpg?signature=old"),
            imageNode("shared_200", "https://scontent.cdninstagram.com/shared.jpg?signature=new")
          ]
        }
      } })]
    });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/shared.jpg?signature=old",
      "https://scontent.cdninstagram.com/shared.jpg?signature=new"
    ]);
  }

  // Fetch/document bounds stop related traversal deterministically.
  {
    let requests = 0;
    const result = await scan("https://www.instagram.com/alice/", {
      scripts: [script({ data: { user: { pk: "91", username: "alice" } } })]
    }, { maxDocuments: 1 }, async (url) => {
      requests += 1;
      return jsonResponse(url, {
        items: [{
          code: "BOUNDED1",
          user: { username: "alice" },
          ...imageNode("901", `https://scontent.cdninstagram.com/bounded-${requests}.jpg`)
        }],
        more_available: true,
        next_max_id: "BLOCKED-BY-LIMIT"
      });
    });
    assert.equal(requests, 1);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].instagramCollections[0].type, "post");
    assert.ok(result.warnings.some((warning) => /bounded document/i.test(warning)));
  }

  // Blob and streaming manifests are not treated as downloadable files. The
  // adapter reports the boundary without inspecting DRM or session storage.
  {
    const result = await scan("https://www.instagram.com/reel/STREAM1/", {
      scripts: [script({ shortcode_media: {
        shortcode: "STREAM1",
        is_video: true,
        video_url: "https://scontent.cdninstagram.com/stream/master.m3u8",
        display_url: "https://scontent.cdninstagram.com/stream-poster.jpg"
      } })]
    });
    assert.equal(result.images.length, 0);
    assert.ok(result.warnings.some((warning) => /no direct progressive HTTP\(S\) file/i.test(warning)));
  }

  // Item limits preserve prefix order and malformed script data is harmless.
  {
    const result = await scan("https://www.instagram.com/p/LIMIT123/", {
      scripts: [
        script("window.data = {not valid JSON", "text/javascript", true),
        script({ shortcode_media: {
          shortcode: "LIMIT123",
          edge_sidecar_to_children: { edges: [
            { node: imageNode("1", "https://scontent.cdninstagram.com/limit-1.jpg") },
            { node: imageNode("2", "https://scontent.cdninstagram.com/limit-2.jpg") }
          ] }
        } })
      ]
    }, { maxItems: 1 });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/limit-1.jpg"
    ]);
    assert.ok(result.warnings.some((warning) => /1-item safety limit/i.test(warning)));
  }

  // The source must never inspect cookies, local/session storage, IndexedDB, or
  // execute page script text while extracting already-exposed data.
  {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../extension/shared/instagram.js"),
      "utf8"
    );
    assert.doesNotMatch(source, /document\s*\.\s*cookie/i);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB)\b/i);
    assert.doesNotMatch(source, /\beval\s*\(|\bFunction\s*\(/);
  }

  console.log("All Instagram route-scoped media adapter checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
