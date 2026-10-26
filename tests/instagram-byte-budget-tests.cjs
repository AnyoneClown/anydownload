"use strict";

const assert = require("assert").strict;
const Instagram = require("../extension/shared/instagram.js");

// Match Firefox's standalone executeScript function serialization.
const collectFromPage = new Function(`return (${Instagram.collectFromPage.toString()});`)();

function response(url, text, { chunkSize = 0, canceled = () => undefined } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    url,
    headers: { get: name => name.toLowerCase() === "content-type" ? "application/json" : null },
    async text() { return text; },
    ...(chunkSize ? { body: { getReader() {
      let offset = 0;
      return {
        async read() {
          // Let all concurrent requests begin reading before their first
          // chunks arrive, reproducing the shared-budget accounting race.
          await Promise.resolve();
          if (offset >= bytes.length) return { done: true };
          const value = bytes.subarray(offset, offset + chunkSize);
          offset += value.byteLength;
          return { done: false, value };
        },
        async cancel() { canceled(); },
        releaseLock() {}
      };
    } } } : {})
  };
}

function photo(code) {
  return { code, media_type: 1, user: { username: "alice" },
    image_versions2: { candidates: [{
      url: `https://scontent.cdninstagram.com/${code}.jpg`, width: 1080, height: 1350
    }] } };
}

async function scan(url, { anchors = [], user = false } = {}, options, fetchImpl) {
  const previous = new Map();
  const script = JSON.stringify({ data: { user: { pk: "42", username: "alice" } } });
  const replacements = {
    location: { href: url },
    document: {
      title: "Instagram byte budget fixture",
      querySelectorAll(selector) {
        if (selector === "a[href]") return anchors.map(code => ({
          getAttribute: name => name === "href" ? `/alice/p/${code}/` : null,
          querySelectorAll: () => []
        }));
        if (selector === "script" && user) return [{
          textContent: script, getAttribute: name => name === "type" ? "application/json" : null
        }];
        return [];
      }
    },
    window: {},
    fetch: fetchImpl
  };
  replacements.window.self = replacements.window;
  replacements.window.top = replacements.window;
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globalThis[name] = value;
  }
  try {
    return await collectFromPage({
      includeProfileReels: false,
      maxDocuments: 32,
      maxDocumentBytes: 16384,
      maxTotalDocumentBytes: 16384,
      ...options
    });
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function run() {
  // Reject an oversized announced body before reading it, and cancel its
  // transfer so repeated exact-post fallbacks cannot download rejected HTML.
  {
    let requests = 0;
    let canceled = 0;
    await scan("https://www.instagram.com/p/BYTEHEADER/", {}, { maxDocuments: 3 }, async url => {
      requests += 1;
      return { ok: true, url, headers: { get(name) {
        return name === "content-length" ? "20000" : "";
      } }, body: { async cancel() { canceled += 1; } },
      async text() { throw new Error("Oversized body must not be read"); } };
    });
    assert.equal(requests, 3);
    assert.equal(canceled, requests);
  }

  // Oversized streamed responses already spent bandwidth. Their consumed
  // bytes must reduce the allowance for the next fallback, which in turn
  // exhausts the aggregate allowance and prevents an additional HTML request.
  {
    const requests = [];
    let canceled = 0;
    const result = await scan("https://www.instagram.com/p/BYTESERIAL/", {}, {
      maxTotalDocumentBytes: 24000
    }, async url => {
      requests.push(url);
      if (requests.length === 1) return response(url, "x".repeat(20000), {
        chunkSize: 10000, canceled: () => { canceled += 1; }
      });
      return response(url, JSON.stringify({ data: { shortcode_media: photo("BYTESERIAL") },
        padding: "x".repeat(5000) }));
    });
    assert.equal(requests.length, 2, "An exhausted aggregate budget must prevent the HTML fallback request");
    assert.equal(canceled, 1, "The oversized stream must be canceled");
    assert.equal(result.images.length, 0, "Previously rejected bytes must count against the next response");
    assert.ok(result.warnings.some(warning => /response-size safety limit/.test(warning)));
  }

  // The non-streaming compatibility path must also charge the entire rejected
  // response, rather than byteLength's truncated page-script prefix.
  {
    let requests = 0;
    const result = await scan("https://www.instagram.com/p/BYTETEXT/", {}, {
      maxTotalDocumentBytes: 24000
    }, async url => {
      requests += 1;
      return response(url, "x".repeat(30000));
    });
    assert.equal(requests, 1, "Oversized text must exhaust the allowance before another request starts");
    assert.equal(result.images.length, 0);
    assert.ok(result.warnings.some(warning => /response-size safety limit/.test(warning)));
  }

  // Independent post lookups share a single allowance while their readers
  // overlap. Only one 10 KB response fits; smaller responses all fit and must
  // not receive a second charge after readResponseText returns.
  for (const paddingLength of [10000, 4000]) {
    const codes = ["BYTEPAR1", "BYTEPAR2", "BYTEPAR3"];
    const requests = [];
    let canceled = 0;
    let nextPost = 0;
    const result = await scan("https://www.instagram.com/alice/", {
      anchors: codes, user: true
    }, {}, async url => {
      requests.push(url);
      if (new URL(url).pathname === "/api/v1/feed/user/42/") {
        return response(url, JSON.stringify({ items: [], more_available: false }));
      }
      assert.match(new URL(url).pathname, /^\/api\/v1\/media\/\d+\/info\/$/);
      const code = codes[nextPost++];
      return response(url, JSON.stringify({ items: [photo(code)], padding: "x".repeat(paddingLength) }), {
        chunkSize: 20000, canceled: () => { canceled += 1; }
      });
    });
    assert.equal(requests.length, 4, "Only the feed and three concurrent post requests may start");
    assert.equal(result.images.length, paddingLength === 10000 ? 1 : 3);
    assert.equal(canceled, paddingLength === 10000 ? 2 : 0);
    assert.equal(result.warnings.some(warning => /response-size safety limit/.test(warning)),
      paddingLength === 10000);
  }

  console.log("All Instagram aggregate response byte-budget checks passed.");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
