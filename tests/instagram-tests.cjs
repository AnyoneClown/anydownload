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

function fakeDomElement(tagName, {
  attributes = {},
  children = [],
  width = 0,
  height = 0,
  properties = {}
} = {}) {
  const normalizedAttributes = Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [String(name).toLowerCase(), String(value)])
  );
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    parentElement: null,
    naturalWidth: width,
    naturalHeight: height,
    videoWidth: width,
    videoHeight: height,
    clientWidth: width,
    clientHeight: height,
    offsetWidth: width,
    offsetHeight: height,
    width,
    height,
    hidden: false,
    isConnected: true,
    style: {},
    getAttribute(name) {
      return normalizedAttributes[String(name).toLowerCase()] ?? null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(normalizedAttributes, String(name).toLowerCase());
    },
    getBoundingClientRect() {
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    },
    getClientRects() {
      return width > 0 && height > 0 ? [this.getBoundingClientRect()] : [];
    },
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === element) {
          return true;
        }
      }
      return false;
    }
  };

  Object.assign(element, properties);
  for (const [name, value] of Object.entries(normalizedAttributes)) {
    if (["src", "href", "poster", "alt", "role"].includes(name) && element[name] === undefined) {
      element[name] = value;
    }
  }
  if (element.src && element.currentSrc === undefined) {
    element.currentSrc = element.src;
  }

  function descendants() {
    const result = [];
    const queue = [...element.children];
    while (queue.length) {
      const child = queue.shift();
      result.push(child);
      queue.unshift(...(child.children || []));
    }
    return result;
  }

  function matchesSelector(candidate, selector) {
    const normalized = String(selector || "").toLowerCase();
    const tag = String(candidate.tagName || "").toLowerCase();
    if (normalized.includes("[role=\"dialog\"]") || normalized.includes("[role='dialog']")) {
      if (candidate.getAttribute("role") !== "dialog" && !normalized.match(/(?:article|main|img|video|a)(?:\b|\[)/)) {
        return false;
      }
    }
    if (/(?:^|[\s,>])article(?:\b|[.#[:])/.test(normalized) && tag === "article") {
      return true;
    }
    if (/(?:^|[\s,>])main(?:\b|[.#[:])/.test(normalized) && tag === "main") {
      return true;
    }
    if (/(?:^|[\s,>])ul(?:\b|[.#[:])/.test(normalized) && tag === "ul") {
      return true;
    }
    if (/(?:^|[\s,>])img(?:\b|[.#[:])/.test(normalized) && tag === "img") {
      return !normalized.includes("[src]") || candidate.hasAttribute("src") || Boolean(candidate.currentSrc);
    }
    if (/(?:^|[\s,>])video(?:\b|[.#[:])/.test(normalized) && tag === "video") {
      return !normalized.includes("[src]") || candidate.hasAttribute("src") || Boolean(candidate.currentSrc);
    }
    if (/(?:^|[\s,>])a(?:\b|[.#[:])/.test(normalized) && tag === "a") {
      if (!normalized.includes("[href]")) {
        return true;
      }
      const href = candidate.getAttribute("href") || "";
      const containsMatch = normalized.match(/href\*=["']([^"']+)["']/);
      return Boolean(href) && (!containsMatch || href.includes(containsMatch[1]));
    }
    if (normalized.trim() === "[role=\"dialog\"]" || normalized.trim() === "[role='dialog']") {
      return candidate.getAttribute("role") === "dialog";
    }
    if (normalized.trim() === "*") {
      return true;
    }
    if (/(?:^|[\s>])\*\s*$/.test(normalized)) {
      return true;
    }
    const attributeMatch = normalized.match(/^\[([a-z0-9_-]+)(?:=["']([^"']*)["'])?\]$/);
    if (attributeMatch) {
      const actual = candidate.getAttribute(attributeMatch[1]);
      return actual !== null && (attributeMatch[2] === undefined || actual === attributeMatch[2]);
    }
    return false;
  }

  element.matches = function matches(selector) {
    return String(selector).split(",").some((part) => matchesSelector(element, part));
  };
  element.closest = function closest(selector) {
    for (let current = element; current; current = current.parentElement) {
      if (typeof current.matches === "function" && current.matches(selector)) {
        return current;
      }
    }
    return null;
  };
  element.querySelectorAll = function querySelectorAll(selector) {
    return descendants().filter((candidate) =>
      String(selector).split(",").some((part) => matchesSelector(candidate, part))
    );
  };
  element.querySelector = function querySelector(selector) {
    return element.querySelectorAll(selector)[0] || null;
  };

  element.children = children;
  for (const child of children) {
    child.parentElement = element;
  }
  return element;
}

function fakeDocument({
  scripts = [],
  anchors = [],
  metas = [],
  elements = [],
  title = "Instagram fixture"
} = {}) {
  const documentRoot = fakeDomElement("html", { children: elements });
  return {
    title,
    documentElement: documentRoot,
    body: documentRoot,
    querySelectorAll(selector) {
      if (selector === "script") {
        return scripts;
      }
      if (selector === "a[href]") {
        return [...anchors, ...documentRoot.querySelectorAll(selector)];
      }
      if (selector === "meta[property], meta[name]") {
        return metas;
      }
      return documentRoot.querySelectorAll(selector);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
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
  const pageDocument = fakeDocument(page);
  const replacements = {
    location: { href: url },
    document: pageDocument,
    window: null
  };
  replacements.window = {
    self: null,
    top: null,
    getComputedStyle(element) {
      return element && element.style || {};
    }
  };
  replacements.window.self = replacements.window;
  replacements.window.top = replacements.window;
  pageDocument.defaultView = replacements.window;
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

function instagramMediaIdFromShortcode(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = 0n;
  for (const character of String(shortcode)) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1, `Invalid Instagram shortcode fixture character: ${character}`);
    value = value * 64n + BigInt(digit);
  }
  return value.toString();
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

  // Instagram can render the visible profile grid while rejecting the
  // session's profile-data API request. The adapter must still keep direct
  // media inside canonical post links, and must not call that primary API
  // failure an unavailable related page.
  {
    const requests = [];
    const result = await scan("https://www.instagram.com/alice/", {
      elements: [fakeDomElement("a", {
        attributes: { href: "/p/VISIBLE1/" },
        children: [fakeDomElement("img", {
          attributes: {
            src: "https://scontent.cdninstagram.com/profile-grid.jpg",
            alt: "Alice dancing"
          },
          width: 1080,
          height: 1350
        })]
      })]
    }, {}, async (url) => {
      requests.push(url);
      return jsonResponse(url, {}, { ok: false });
    });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/profile-grid.jpg"
    ]);
    assert.deepEqual(result.images[0].instagramCollections, [{
      type: "post",
      id: "VISIBLE1",
      title: "",
      owner: "alice"
    }]);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/api\/v1\/users\/web_profile_info\//);
    assert.ok(!result.warnings.some((warning) => /related Instagram page/i.test(warning)));
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

  // A partial active-slide hydration does not suppress the exact API fallback;
  // the full carousel replaces that incomplete view without related media.
  {
    let fetchCount = 0;
    const active = {
      shortcode: "POST123",
      owner: { username: "alice" },
      accessibility_caption: "Alice's post",
      ...imageNode("1", "https://scontent.cdninstagram.com/post-visible.jpg", 1440, 1800)
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
    }, async (url, init) => {
      fetchCount += 1;
      assert.equal(
        new URL(url).pathname,
        `/api/v1/media/${instagramMediaIdFromShortcode("POST123")}/info/`
      );
      assert.equal(init.credentials, "include");
      return jsonResponse(url, { items: [{
        code: "POST123",
        owner: { username: "alice" },
        carousel_media: [
          {
            ...imageNode("1", "https://scontent.cdninstagram.com/post-large.jpg", 1440, 1800),
            accessibility_caption: "Alice's post"
          },
          imageNode("3", "https://scontent.cdninstagram.com/post-second.jpg")
        ]
      }, unrelated] });
    });
    assert.equal(result.handled, true);
    assert.equal(result.images.length, 2);
    assert.equal(result.images[0].url, "https://scontent.cdninstagram.com/post-large.jpg");
    assert.equal(result.images[0].previewUrl, "https://scontent.cdninstagram.com/post-large.jpg?size=small");
    assert.equal(result.images[0].width, 1440);
    assert.equal(result.images[0].height, 1800);
    assert.equal(result.images[0].alt, "Alice's post");
    assert.equal(result.images[0].mediaType, "image");
    assert.equal(result.images[1].url, "https://scontent.cdninstagram.com/post-second.jpg");
    assert.equal(fetchCount, 1);
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

  // When the live SPA no longer exposes its post payload, the canonical exact
  // post HTML is fetched with the current session and remains shortcode-scoped.
  {
    const shortcode = "HTML123";
    const requests = [];
    const target = {
      code: shortcode,
      user: { username: "alice" },
      carousel_media: [
        imageNode("html-1", "https://scontent.cdninstagram.com/html-1.jpg"),
        videoNode(
          "html-2",
          "https://scontent.cdninstagram.com/html-2.mp4",
          "https://scontent.cdninstagram.com/html-2-poster.jpg"
        ),
        imageNode("html-3", "https://scontent.cdninstagram.com/html-3.jpg")
      ]
    };
    const unrelated = {
      code: "OTHER999",
      user: { username: "mallory" },
      ...imageNode("html-other", "https://scontent.cdninstagram.com/html-other.jpg")
    };
    const result = await scan(
      `https://www.instagram.com/p/${shortcode}/?img_index=2`,
      {},
      {},
      async (url, init) => {
        requests.push({ url, init });
        if (new URL(url).pathname !== `/p/${shortcode}/`) {
          return jsonResponse(url, { items: [] }, { ok: false });
        }
        return response(
          `https://www.instagram.com/p/${shortcode}/`,
          htmlDocument({ scripts: [{ value: {
            data: { xig_polaris_media: target },
            suggested: unrelated
          } }] })
        );
      }
    );
    assert.equal(requests.length, 3);
    const htmlRequest = requests[2];
    assert.equal(new URL(htmlRequest.url).pathname, `/p/${shortcode}/`);
    assert.equal(htmlRequest.init.method, "GET");
    assert.equal(htmlRequest.init.credentials, "include");
    assert.equal(htmlRequest.init.cache, "no-store");
    assert.match(htmlRequest.init.headers.Accept, /text\/html/i);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/html-1.jpg",
      "https://scontent.cdninstagram.com/html-2.mp4",
      "https://scontent.cdninstagram.com/html-3.jpg"
    ]);
    assert.equal(result.images[1].mediaType, "video");
    assert.ok(result.images.every((item) =>
      item.instagramCollections.length === 1 &&
      item.instagramCollections[0].type === "post" &&
      item.instagramCollections[0].id === shortcode &&
      item.instagramCollections[0].owner === "alice"
    ));
  }

  // A fetched script must identify the requested post. A generic
  // `shortcode_media` property is not sufficient evidence on its own.
  {
    const shortcode = "IDENTITY123";
    let requestCount = 0;
    const result = await scan(`https://www.instagram.com/p/${shortcode}/`, {}, {},
      async (url) => {
        requestCount += 1;
        if (new URL(url).pathname === `/p/${shortcode}/`) {
          return response(url, htmlDocument({ scripts: [{ value: {
            shortcode_media: imageNode(
              "identity-less",
              "https://scontent.cdninstagram.com/identity-less.jpg"
            )
          } }] }));
        }
        return jsonResponse(url, { items: [] }, { ok: false });
      });
    assert.deepEqual(result.images, []);
    assert.equal(requestCount, 3);
  }

  // If canonical HTML is unavailable, the shortcode is decoded without Number
  // precision loss and the authenticated numeric media-info response supplies
  // every exact carousel child.
  {
    const shortcode = "MEDIA_123";
    const mediaId = instagramMediaIdFromShortcode(shortcode);
    const requests = [];
    const target = {
      code: shortcode,
      user: { username: "alice" },
      carousel_media: [
        imageNode("info-1", "https://scontent.cdninstagram.com/info-1.jpg"),
        imageNode("info-2", "https://scontent.cdninstagram.com/info-2.jpg")
      ]
    };
    const result = await scan(`https://www.instagram.com/p/${shortcode}/`, {}, {}, async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/api/v1/media/${mediaId}/info/`);
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "include");
      assert.equal(init.cache, "no-store");
      assert.equal(init.headers["X-IG-App-ID"], "936619743392459");
      assert.match(init.headers.Accept, /json/i);
      return jsonResponse(url, {
        items: [target, {
          code: "OTHER999",
          user: { username: "mallory" },
          ...imageNode("info-other", "https://scontent.cdninstagram.com/info-other.jpg")
        }]
      });
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/info-1.jpg",
      "https://scontent.cdninstagram.com/info-2.jpg"
    ]);
  }

  // The observed opaque private-share permalink maps to its conventional
  // 11-character media prefix. Both exact endpoints remain session-scoped and
  // validate that canonical alias before accepting the full carousel.
  {
    const shortcode = "DVgyxbajZDTFJgFEu-CMuaiNuJSiQQhfJ_U8YY0";
    const canonicalShortcode = "DVgyxbajZDT";
    const canonicalMediaId = instagramMediaIdFromShortcode(canonicalShortcode);
    const requests = [];
    const result = await scan(`https://www.instagram.com/p/${shortcode}/?img_index=1`, {}, {},
      async (url, init) => {
        requests.push({ url, init });
        const parsed = new URL(url);
        if (requests.length === 1) {
          assert.equal(parsed.pathname, `/api/v1/media/${canonicalMediaId}/info/`);
          return jsonResponse(url, { items: [] }, { ok: false });
        }
        assert.equal(parsed.pathname, "/graphql/query/");
        assert.equal(parsed.searchParams.get("doc_id"), "27852811784380813");
        const variables = JSON.parse(parsed.searchParams.get("variables"));
        assert.deepEqual(variables, {
          shortcode: canonicalShortcode,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
          __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false
        });
        assert.equal(init.credentials, "include");
        assert.equal(init.cache, "no-store");
        assert.equal(init.headers["X-IG-App-ID"], "936619743392459");
        return jsonResponse(url, {
          data: {
            xdt_api__v1__media__shortcode__web_info: {
              items: [{
                code: canonicalShortcode,
                user: { username: "alice" },
                carousel_media: [
                  imageNode("query-1", "https://scontent.cdninstagram.com/query-1.jpg"),
                  imageNode("query-2", "https://scontent.cdninstagram.com/query-2.jpg")
                ]
              }, {
                code: "OTHER999",
                ...imageNode("query-other", "https://scontent.cdninstagram.com/query-other.jpg")
              }]
            }
          },
          status: "ok"
        });
      });
    assert.equal(requests.length, 2);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/query-1.jpg",
      "https://scontent.cdninstagram.com/query-2.jpg"
    ]);
  }

  // A redirected canonical response for another shortcode is never trusted.
  // Subsequent bounded fallbacks may run, but unrelated media cannot leak into
  // the exact-post result when all of them fail.
  {
    const requests = [];
    const result = await scan("https://www.instagram.com/p/STRICT123/", {}, {}, async (url) => {
      requests.push(url);
      if (new URL(url).pathname === "/p/STRICT123/") {
        return response(
          "https://www.instagram.com/p/OTHER999/",
          htmlDocument({ scripts: [{ value: { shortcode_media: {
            shortcode: "STRICT123",
            user: { username: "alice" },
            ...imageNode("redirected", "https://scontent.cdninstagram.com/redirected.jpg")
          } } }] })
        );
      }
      return jsonResponse(url, { items: [] }, { ok: false });
    });
    assert.equal(result.handled, true);
    assert.deepEqual(result.images, []);
    assert.ok(requests.length >= 1 && requests.length <= 3, "Exact fallbacks must stay bounded");
    assert.ok(result.warnings.some((warning) => /downloadable post media/i.test(warning)));
  }

  // React's current exact-viewer props can still supply the full carousel
  // without any network fallback. Unrelated prefetched posts remain excluded.
  {
    let fetchCount = 0;
    const runtimeNode = fakeDomElement("div");
    runtimeNode["__reactProps$fixture"] = {
      children: {
        currentPost: {
          code: "RUNTIME123",
          user: { username: "alice" },
          carousel_media: [
            imageNode("runtime-1", "https://scontent.cdninstagram.com/runtime-1.jpg"),
            imageNode("runtime-2", "https://scontent.cdninstagram.com/runtime-2.jpg")
          ]
        },
        suggestedPost: {
          code: "OTHER999",
          user: { username: "mallory" },
          ...imageNode("runtime-other", "https://scontent.cdninstagram.com/runtime-other.jpg")
        }
      }
    };
    const result = await scan("https://www.instagram.com/p/RUNTIME123/?img_index=2", {
      elements: [runtimeNode]
    }, {}, async () => {
      fetchCount += 1;
      throw new Error("Current exact-viewer runtime data must avoid fallback fetches.");
    });
    assert.equal(fetchCount, 0);
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/runtime-1.jpg",
      "https://scontent.cdninstagram.com/runtime-2.jpg"
    ]);
  }

  // The final DOM fallback is restricted to the exact viewer. It keeps large
  // post media while excluding avatars and large media in sibling articles.
  {
    const exactLink = fakeDomElement("a", {
      attributes: { href: "/p/DOM123/" }
    });
    const avatar = fakeDomElement("img", {
      attributes: {
        src: "https://scontent.cdninstagram.com/avatar.jpg",
        alt: "alice's profile picture"
      },
      width: 150,
      height: 150
    });
    const first = fakeDomElement("img", {
      attributes: { src: "https://scontent.cdninstagram.com/dom-1.jpg", alt: "Post photo" },
      width: 1080,
      height: 1350
    });
    const second = fakeDomElement("img", {
      attributes: { src: "https://scontent.cdninstagram.com/dom-2.jpg", alt: "Post photo" },
      width: 1080,
      height: 1350
    });
    const exactArticle = fakeDomElement("article", {
      attributes: { "data-shortcode": "DOM123" },
      children: [exactLink, avatar, first, second]
    });
    const dialog = fakeDomElement("div", {
      attributes: { role: "dialog", "aria-label": "Post viewer" },
      children: [exactArticle]
    });
    const unrelatedArticle = fakeDomElement("article", {
      children: [
        fakeDomElement("a", { attributes: { href: "/p/OTHER999/" } }),
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/dom-unrelated-1.jpg" },
          width: 1440,
          height: 1800
        }),
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/dom-unrelated-2.jpg" },
          width: 1440,
          height: 1800
        }),
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/dom-unrelated-3.jpg" },
          width: 1440,
          height: 1800
        })
      ]
    });
    const result = await scan("https://www.instagram.com/p/DOM123/", {
      elements: [fakeDomElement("main", { children: [unrelatedArticle] }), dialog]
    }, {}, async (url) => response(url, "Forbidden", { ok: false }));
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/dom-1.jpg",
      "https://scontent.cdninstagram.com/dom-2.jpg"
    ]);
  }

  // A mixed dialog can contain recommendation tracks. Candidate-level route
  // evidence keeps the exact track even when the unrelated track has more media.
  {
    const exactTrack = fakeDomElement("ul", {
      children: [
        fakeDomElement("a", { attributes: { href: "/p/MIXED123/" } }),
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/mixed-exact.jpg" },
          width: 1080,
          height: 1350
        })
      ]
    });
    const otherTrack = fakeDomElement("ul", {
      children: [
        fakeDomElement("a", { attributes: { href: "/p/OTHER999/" } }),
        ...[1, 2, 3].map((index) => fakeDomElement("img", {
          attributes: { src: `https://scontent.cdninstagram.com/mixed-other-${index}.jpg` },
          width: 1440,
          height: 1800
        }))
      ]
    });
    const result = await scan("https://www.instagram.com/p/MIXED123/", {
      elements: [fakeDomElement("div", {
        attributes: { role: "dialog" },
        children: [exactTrack, otherTrack]
      })]
    }, {}, async (url) => jsonResponse(url, { items: [] }, { ok: false }));
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://scontent.cdninstagram.com/mixed-exact.jpg"
    ]);
  }

  // When two media-bearing articles have no exact-route evidence, the DOM
  // fallback refuses to guess based on media count and expose a recommendation.
  {
    const firstArticle = fakeDomElement("article", {
      children: [fakeDomElement("img", {
        attributes: { src: "https://scontent.cdninstagram.com/unmarked-current.jpg" },
        width: 1080,
        height: 1350
      })]
    });
    const largerSibling = fakeDomElement("article", {
      children: [
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/unmarked-other-1.jpg" },
          width: 1440,
          height: 1800
        }),
        fakeDomElement("img", {
          attributes: { src: "https://scontent.cdninstagram.com/unmarked-other-2.jpg" },
          width: 1440,
          height: 1800
        })
      ]
    });
    const result = await scan("https://www.instagram.com/p/UNMARKED1/", {
      elements: [fakeDomElement("main", { children: [firstArticle, largerSibling] })]
    }, {}, async (url) => jsonResponse(url, { items: [] }, { ok: false }));
    assert.deepEqual(result.images, []);
    assert.ok(result.warnings.some((warning) => /downloadable post media/i.test(warning)));
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
        url: "https://www.instagram.com/reel/LDJSON1/",
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

  // Username-prefixed post links are still exact post scopes and never fetch
  // related collections when their structured single-item type is complete.
  {
    let fetchCount = 0;
    const result = await scan("https://www.instagram.com/alice/p/OWNERPOST/", {
      scripts: [script({ shortcode_media: {
        shortcode: "OWNERPOST",
        media_type: 1,
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
