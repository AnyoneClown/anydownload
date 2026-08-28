"use strict";

const assert = require("assert").strict;
const YouTube = require("../extension/shared/youtube.js");

const VIDEO_ID = "dQw4w9WgXcQ";
const DIRECT_MP4 = "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18&expire=9999999999&token=keep%2Bme";
const DIRECT_WEBM = "https://rr2---sn-test.googlevideo.com/videoplayback?itag=248&expire=9999999999";

function pageResponse(overrides) {
  return Object.assign({
    playabilityStatus: { status: "OK" },
    videoDetails: {
      videoId: VIDEO_ID,
      title: "A / useful: test video",
      lengthSeconds: "213.4",
      thumbnail: {
        thumbnails: [
          { url: "https://i.ytimg.com/vi/test/default.jpg", width: 120, height: 90 },
          { url: "https://i.ytimg.com/vi/test/maxresdefault.jpg", width: 1280, height: 720 },
          { url: "https://attacker.test/not-a-poster.jpg", width: 9999, height: 9999 }
        ]
      }
    },
    streamingData: {
      formats: [{
        itag: 18,
        url: DIRECT_MP4,
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        width: 640,
        height: 360,
        qualityLabel: "360p",
        bitrate: 500000,
        contentLength: "123456",
        drmFamilies: ["TEST_METADATA_ONLY"]
      }],
      adaptiveFormats: [
        {
          itag: 248,
          url: DIRECT_WEBM,
          mimeType: 'video/webm; codecs="vp9"',
          width: 1920,
          height: 1080,
          qualityLabel: "1080p",
          fps: 60,
          bitrate: 2400000
        },
        {
          itag: 140,
          url: "https://rr1---sn-test.googlevideo.com/videoplayback?itag=140",
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          audioQuality: "AUDIO_QUALITY_MEDIUM"
        },
        {
          itag: 137,
          signatureCipher: "url=https%3A%2F%2Fexample.invalid&s=secret&sp=sig",
          mimeType: 'video/mp4; codecs="avc1.640028"',
          width: 1920,
          height: 1080,
          qualityLabel: "1080p"
        }
      ],
      serverAbrStreamingUrl: "https://rr1---sn-test.googlevideo.com/videoplayback?sabr=1"
    }
  }, overrides || {});
}

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

async function run() {
assert.equal(typeof YouTube.collectYouTubeMediaFromPage, "function");
assert.equal(typeof YouTube.isYouTubeUrl, "function");
assert.equal(YouTube.isYouTubeUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`), true);
assert.equal(YouTube.isYouTubeUrl(`https://youtu.be/${VIDEO_ID}`), true);
assert.equal(YouTube.isYouTubeUrl(`https://music.youtube.com/watch?v=${VIDEO_ID}`), true);
assert.equal(YouTube.isYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ"), false);
assert.equal(YouTube.isYouTubeUrl("javascript:alert(1)"), false);

// Direct, complete formats are returned unchanged. A direct URL is not blocked
// merely because its metadata mentions protected playback; no licence or
// decryption operation is attempted.
{
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    pageTitle: "Fallback title - YouTube",
    playerResponses: [pageResponse()],
    requestPlayerApi: false
  });
  assert.equal(result.handled, true);
  assert.equal(result.images.length, 1, "The default result should be a complete video+audio file");
  const video = result.images[0];
  assert.equal(video.url, DIRECT_MP4, "Signed direct URLs must not be rewritten");
  assert.equal(video.previewUrl, "https://i.ytimg.com/vi/test/maxresdefault.jpg");
  assert.equal(video.mimeType, "video/mp4");
  assert.equal(video.mediaType, "video");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(video.duration, 213.4);
  assert.equal(video.hasAudio, true);
  assert.equal(video.identityKey, `youtube:${VIDEO_ID}:18`);
  assert.equal(video.protectedPlaybackMetadata, true);
  assert.match(video.filename, /^A _ useful_ test video - 360p\.mp4$/);
  assert.deepEqual(video.kinds, ["YouTube direct file", "360p video + audio"]);
  assert.ok(result.warnings.some((warning) => /does not merge separate streams/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /listed unchanged.*does not obtain licences or decrypt/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /links expire/i.test(warning)));
}

// Video-only variants can be requested explicitly, but audio-only formats are
// never mislabeled as downloadable videos.
{
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    playerResponses: [pageResponse()],
    includeVideoOnly: true,
    requestPlayerApi: false
  });
  assert.deepEqual(result.images.map((item) => item.itag), [18, 248]);
  assert.equal(result.images[1].hasAudio, false);
  assert.match(result.images[1].filename, /1080p 60fps video-only\.webm$/);
}

// The collector never extracts or evaluates signatureCipher, nor does it offer
// SABR as if it were a normal file.
{
  const response = pageResponse({
    streamingData: {
      formats: [],
      adaptiveFormats: [{
        itag: 137,
        signatureCipher: "url=https%3A%2F%2Fexample.invalid&s=secret&sp=sig",
        mimeType: 'video/mp4; codecs="avc1.640028"',
        qualityLabel: "1080p"
      }],
      serverAbrStreamingUrl: "https://rr1---sn-test.googlevideo.com/videoplayback?sabr=1"
    }
  });
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    playerResponses: [response],
    requestPlayerApi: false
  });
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((warning) => /signature-ciphered.*does not defeat URL signatures/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /SABR.*does not reconstruct/i.test(warning)));
}

// Even a syntactically valid direct URL is rejected unless it points to
// YouTube's media delivery host.
{
  const response = pageResponse({
    streamingData: {
      formats: [{
        itag: 18,
        url: "https://attacker.test/video.mp4",
        mimeType: "video/mp4",
        width: 640,
        height: 360
      }]
    }
  });
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    playerResponses: [response],
    requestPlayerApi: false
  });
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((warning) => /outside its downloadable video host/i.test(warning)));
}

// A bounded inline assignment works in Firefox's isolated scripting world,
// where page JavaScript globals are normally hidden.
await withGlobals({
  document: {
    title: "Inline fixture - YouTube",
    documentElement: { lang: "en" },
    getElementById() {
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "script");
      return [{ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(pageResponse())};` }];
    }
  }
}, async () => {
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    requestPlayerApi: false
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, DIRECT_MP4);
});

// When the page only exposes SABR, one anonymous, same-origin player request is
// allowed. Only direct URLs in its bounded JSON response are accepted.
await withGlobals({
  document: {
    title: "Short fixture - YouTube",
    documentElement: { lang: "uk-UA" },
    getElementById() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  },
  fetch: async (url, init) => {
    assert.equal(url, "https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.headers["X-YouTube-Client-Name"], "28");
    assert.equal(Object.keys(init.headers).some((name) => /cookie|authorization/i.test(name)), false);
    const body = JSON.parse(init.body);
    assert.equal(body.videoId, VIDEO_ID);
    assert.equal(body.context.client.clientName, "ANDROID_VR");
    assert.equal(body.context.client.hl, "uk-UA");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(pageResponse());
      }
    };
  }
}, async () => {
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/shorts/${VIDEO_ID}`,
    playerResponses: [{
      videoDetails: { videoId: VIDEO_ID, title: "Short fixture" },
      streamingData: { serverAbrStreamingUrl: "https://rr1---sn-test.googlevideo.com/sabr" }
    }]
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, DIRECT_MP4);
});

// If the anonymous VR profile exposes only a video-only track, the collector
// falls back once to the standard Android profile for a complete file.
await withGlobals({
  document: {
    title: "Android fallback fixture - YouTube",
    documentElement: { lang: "en" },
    getElementById() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  },
  fetch: (() => {
    const calls = [];
    const fixture = async (url, init) => {
      const callIndex = calls.length;
      calls.push({ url, init });
      assert.equal(url, "https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.referrerPolicy, "no-referrer");
      const body = JSON.parse(init.body);
      assert.equal(body.videoId, VIDEO_ID);
      if (callIndex === 0) {
        assert.equal(init.headers["X-YouTube-Client-Name"], "28");
        assert.equal(init.headers["X-YouTube-Client-Version"], "1.65.10");
        assert.equal(body.context.client.clientName, "ANDROID_VR");
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(pageResponse({
              streamingData: {
                formats: [],
                adaptiveFormats: [{
                  itag: 248,
                  url: DIRECT_WEBM,
                  mimeType: 'video/webm; codecs="vp9"',
                  width: 1920,
                  height: 1080,
                  qualityLabel: "1080p"
                }]
              }
            }));
          }
        };
      }
      assert.equal(callIndex, 1, "Only VR and standard Android profiles may be requested");
      assert.equal(init.headers["X-YouTube-Client-Name"], "3");
      assert.equal(init.headers["X-YouTube-Client-Version"], "21.02.35");
      assert.equal(body.context.client.clientName, "ANDROID");
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(pageResponse());
        }
      };
    };
    fixture.calls = calls;
    return fixture;
  })()
}, async () => {
  const fetchFixture = globalThis.fetch;
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    playerResponses: [{
      videoDetails: { videoId: VIDEO_ID, title: "Android fallback fixture" },
      streamingData: { serverAbrStreamingUrl: "https://rr1---sn-test.googlevideo.com/sabr" }
    }]
  });
  assert.equal(fetchFixture.calls.length, 2, "The fallback must make exactly two anonymous calls");
  assert.ok(fetchFixture.calls.every((call) => call.init.credentials === "omit"));
  assert.deepEqual(result.images.map((item) => item.itag), [18]);
  assert.equal(result.images[0].url, DIRECT_MP4);
});

// Oversized endpoint responses are rejected before JSON parsing.
await withGlobals({
  fetch: async () => ({
    ok: true,
    status: 200,
    async text() {
      return " ".repeat(1100);
    }
  })
}, async () => {
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    maxResponseBytes: 1000
  });
  assert.equal(result.images.length, 0);
  assert.ok(result.warnings.some((warning) => /response exceeded the safety limit/i.test(warning)));
});

// Non-YouTube pages are explicitly unhandled and make no player request.
await withGlobals({
  fetch: async () => {
    throw new Error("fetch must not run");
  }
}, async () => {
  const result = await YouTube.collectYouTubeMediaFromPage({
    pageUrl: "https://example.test/watch?v=dQw4w9WgXcQ"
  });
  assert.equal(result.handled, false);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.warnings, []);
});

// Firefox receives a serialized function with no module closure. Exercise that
// exact shape so future refactors cannot accidentally add an outer dependency.
{
  const detachedCollector = (0, eval)(`(${YouTube.collectYouTubeMediaFromPage.toString()})`);
  const result = await detachedCollector({
    pageUrl: `https://youtu.be/${VIDEO_ID}`,
    playerResponses: [pageResponse()],
    requestPlayerApi: false
  });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, DIRECT_MP4);
}

console.log("All YouTube collector checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
