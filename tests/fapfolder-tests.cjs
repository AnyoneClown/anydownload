"use strict";

const assert = require("assert").strict;
const FapFolder = require("../extension/shared/fapfolder.js");

assert.equal(typeof FapFolder.collectFromPage, "function");
assert.equal(typeof FapFolder.isSupportedUrl, "function");
assert.equal(typeof FapFolder.routeKeyForUrl, "function");
assert.equal(
  FapFolder.isSupportedUrl("https://fapfolder.club/groups/larapechika/videos"),
  true
);
assert.equal(FapFolder.isSupportedUrl("https://www.fapfolder.club/posts/92755"), true);
assert.equal(FapFolder.isSupportedUrl("http://fapfolder.club/posts/92755"), false);
assert.equal(FapFolder.isSupportedUrl("https://fapfolder.club/groups/larapechika"), false);
assert.equal(FapFolder.isSupportedUrl("https://fapfolder.club.evil.test/posts/92755"), false);
assert.equal(FapFolder.isSupportedUrl("javascript:alert(1)"), false);
assert.equal(
  FapFolder.routeKeyForUrl("https://fapfolder.club/groups/LaraPechika/videos?sort=new"),
  "fapfolder:group-videos:larapechika"
);
assert.equal(
  FapFolder.routeKeyForUrl("https://fapfolder.club/posts/Igu5CdeZn7"),
  "fapfolder:post:igu5cdezn7"
);

// Firefox serializes the function without its module closure.
const collectFromPage = new Function(`return (${FapFolder.collectFromPage.toString()});`)();

async function withGlobals(values, callback) {
  const descriptors = new Map();
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }
  try {
    return await callback();
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
}

function element(tagName, attributes = {}, properties = {}) {
  const normalized = Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [String(name).toLowerCase(), String(value)])
  );
  return Object.assign({
    localName: String(tagName).toLowerCase(),
    tagName: String(tagName).toUpperCase(),
    getAttribute(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    }
  }, properties);
}

function postAnchor(href, previewUrl, title) {
  const image = element("img", { src: previewUrl, alt: title }, { src: previewUrl, currentSrc: previewUrl });
  return element("a", { href, class: "pg_video" }, {
    href,
    querySelector(selector) {
      return selector === "img" ? image : null;
    }
  });
}

function fakeDocument({ title = "FapFolder", anchors = [], candidates = [], bodyText = "" } = {}) {
  return {
    title,
    body: { textContent: bodyText },
    querySelectorAll(selector) {
      if (String(selector).startsWith("a.pg_video")) {
        return anchors;
      }
      if (String(selector).includes(".vid-placeholder[data-src]")) {
        return candidates;
      }
      return [];
    },
    querySelector() {
      return null;
    }
  };
}

function lazyVideo(url, poster, duration) {
  return element("div", {
    class: "vid-placeholder",
    "data-src": url,
    "data-poster": poster,
    "data-length": duration,
    "data-id": "video-fixture"
  });
}

function response(url, body, byteLength) {
  return {
    ok: true,
    status: 200,
    url,
    body: null,
    headers: {
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === "content-type") {
          return "text/html; charset=UTF-8";
        }
        if (normalized === "content-length") {
          return String(byteLength || body.length);
        }
        return null;
      }
    },
    async text() {
      return body;
    }
  };
}

async function run() {
  const unsupported = await collectFromPage({
    pageUrl: "https://example.test/groups/larapechika/videos"
  });
  assert.equal(unsupported.handled, false);
  assert.deepEqual(unsupported.images, []);

  // Exact post pages expose lazy placeholders before the site's player turns
  // them into <video><source> nodes.
  await withGlobals({
    location: { href: "https://fapfolder.club/posts/igu5cdezn7" },
    document: fakeDocument({
      title: "One post",
      candidates: [lazyVideo(
        "https://fap.onl/uploads/videos/first.mp4?token=keep",
        "https://fap.onl/uploads/thumbnails/first.jpg",
        "91.5"
      )]
    }),
    fetch: async () => {
      throw new Error("Exact post collection must not refetch the current document");
    }
  }, async () => {
    const result = await collectFromPage({ successCacheTtlMs: 0, emptyCacheTtlMs: 0 });
    assert.equal(result.handled, true);
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.images[0], {
      url: "https://fap.onl/uploads/videos/first.mp4?token=keep",
      previewUrl: "https://fap.onl/uploads/thumbnails/first.jpg",
      filename: "",
      alt: "One post",
      width: 0,
      height: 0,
      duration: 91.5,
      mimeType: "video/mp4",
      mediaType: "video",
      kinds: ["FapFolder lazy post video"],
      sourceProvider: "fapfolder",
      sourcePostUrl: "https://fapfolder.club/posts/igu5cdezn7"
    });
    assert.deepEqual(result.warnings, []);
  });

  const firstPost = "https://fapfolder.club/posts/92755";
  const secondPost = "https://fapfolder.club/posts/84349";
  const loginPost = "https://fapfolder.club/posts/84348";
  const listing = fakeDocument({
    title: "larapechika videos",
    anchors: [
      postAnchor(firstPost, "https://fap.onl/uploads/thumbnails/first.jpg", "First post"),
      postAnchor(secondPost, "https://fap.onl/uploads/thumbnails/second.jpg", "Second post"),
      postAnchor(loginPost, "https://fap.onl/uploads/thumbnails/login.jpg", "Login post"),
      postAnchor(firstPost, "https://fap.onl/uploads/thumbnails/duplicate.jpg", "Duplicate")
    ]
  });
  const parsedDocuments = new Map([
    ["first-html", fakeDocument({
      title: "First post page",
      candidates: [lazyVideo("https://fap.onl/uploads/videos/first.mp4", "", "12")]
    })],
    ["second-html", fakeDocument({
      title: "Second post page",
      candidates: [lazyVideo("https://fap.onl/uploads/videos/second.webm", "", "34")]
    })],
    ["login-html", fakeDocument({
      title: "Login required",
      bodyText: "Sorry, you must log in to watch the video :("
    })]
  ]);
  class FakeDOMParser {
    parseFromString(text, type) {
      assert.equal(type, "text/html");
      return parsedDocuments.get(text);
    }
  }
  const fetchCalls = [];
  let activeFetches = 0;
  let maximumActiveFetches = 0;

  await withGlobals({
    location: { href: "https://fapfolder.club/groups/larapechika/videos" },
    document: listing,
    DOMParser: FakeDOMParser,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      const delay = url === firstPost ? 15 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      activeFetches -= 1;
      if (url === firstPost) {
        return response(firstPost, "first-html");
      }
      if (url === secondPost) {
        return response(secondPost, "second-html");
      }
      return response(loginPost, "login-html");
    }
  }, async () => {
    const result = await collectFromPage({
      maxConcurrency: 2,
      maxPosts: 10,
      successCacheTtlMs: 0,
      emptyCacheTtlMs: 0
    });
    assert.equal(result.handled, true);
    assert.deepEqual(
      result.images.map((image) => image.url),
      [
        "https://fap.onl/uploads/videos/first.mp4",
        "https://fap.onl/uploads/videos/second.webm"
      ],
      "Post completion order must not change the listing's source order"
    );
    assert.deepEqual(
      result.images.map((image) => image.previewUrl),
      [
        "https://fap.onl/uploads/thumbnails/first.jpg",
        "https://fap.onl/uploads/thumbnails/second.jpg"
      ],
      "Listing thumbnails must remain usable as post-video previews"
    );
    assert.deepEqual(result.images.map((image) => image.mimeType), ["video/mp4", "video/webm"]);
    assert.equal(fetchCalls.length, 3, "Duplicate post links must be fetched once");
    assert.ok(maximumActiveFetches <= 2, "Post traversal must respect bounded concurrency");
    for (const call of fetchCalls) {
      assert.equal(call.options.method, "GET");
      assert.equal(call.options.credentials, "include");
      assert.equal(call.options.redirect, "follow");
    }
    assert.ok(result.warnings.some((warning) => /1 FapFolder post requires login/i.test(warning)));
  });

  let cachedFetches = 0;
  await withGlobals({
    location: { href: "https://fapfolder.club/groups/larapechika/videos" },
    document: fakeDocument({
      anchors: [postAnchor(firstPost, "https://fap.onl/uploads/thumbnails/first.jpg", "First")]
    }),
    DOMParser: FakeDOMParser,
    fetch: async () => {
      cachedFetches += 1;
      return response(firstPost, "first-html");
    },
    __anyDownloadFapFolderPostCacheV1: undefined
  }, async () => {
    const options = { successCacheTtlMs: 60000, emptyCacheTtlMs: 0 };
    const first = await collectFromPage(options);
    const second = await collectFromPage(options);
    assert.equal(first.images.length, 1);
    assert.deepEqual(second.images, first.images);
    assert.equal(cachedFetches, 1, "Successful post results must be reused across live scans");
  });

  // Oversized post responses are rejected without mislabeling their contents.
  await withGlobals({
    location: { href: "https://fapfolder.club/groups/larapechika/videos" },
    document: fakeDocument({ anchors: [postAnchor(firstPost, "", "First")] }),
    DOMParser: FakeDOMParser,
    fetch: async () => response(firstPost, "first-html", 5000000)
  }, async () => {
    const result = await collectFromPage({
      maxDocumentBytes: 16384,
      successCacheTtlMs: 0,
      emptyCacheTtlMs: 0
    });
    assert.deepEqual(result.images, []);
    assert.ok(result.warnings.some((warning) => /response-size limit/i.test(warning)));
    assert.ok(result.warnings.some((warning) => /could not be inspected/i.test(warning)));
  });

  console.log("All FapFolder post-video collector checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
