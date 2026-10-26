"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const Instagram = require("../extension/shared/instagram.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const runId = "instagram-progress-test-0001";
const photo = id => ({ pk: id, code: `POST${id}`, user: { pk: "42", username: "alice" },
  image_versions2: { candidates: [{ url: `https://scontent.cdninstagram.com/${id}.jpg`, width: 1000, height: 800 }] } });
function response(url, value) {
  return { ok: true, url, headers: { get: () => "application/json" }, text: async () => JSON.stringify(value) };
}
function harness(fetchImpl, anchors = []) {
  const requests = [];
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    location: { href: "https://www.instagram.com/alice/" },
    document: { title: "Alice", querySelectorAll(selector) {
      if (selector === "script") return [{ getAttribute: () => "application/json",
        textContent: JSON.stringify({ user: { pk: "42", username: "alice" } }) }];
      if (selector === "a[href]") return anchors.map(href => ({ getAttribute: () => href }));
      return [];
    } },
    fetch(url, init) { requests.push({ url, init }); return fetchImpl(url, init); }
  });
  return {
    requests,
    collect: vm.runInContext(`(${Instagram.collectFromPage})`, context),
    control: vm.runInContext(`(${Instagram.controlCollection})`, context)
  };
}

async function checkProgressAndCancel() {
  let waiting = false;
  let aborted = false;
  const page = harness((url, init) => {
    if (!new URL(url).searchParams.has("max_id")) {
      return response(url, { items: [photo("101"), photo("102")], more_available: true, next_max_id: "next" });
    }
    waiting = true;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true }));
  });
  const scan = page.collect({ runId, maxDocuments: 32, includeProfileReels: false });
  await tick();
  assert.equal(waiting, true);
  const progress = page.control(runId, "status");
  assert.equal(progress.posts, 2, "Posts are counted before later pages finish");
  assert.equal(progress.media, 2);
  assert.equal(progress.phase, "posts");
  assert.equal(page.control("wrong-run-token", "cancel"), null);
  assert.equal(aborted, false);
  page.control(runId, "cancel");
  const result = await scan;
  assert.equal(aborted, true, "Stop aborts the actual request");
  assert.equal(page.requests.length, 2, "No fallback or additional pages are requested after Stop");
  assert.equal(result.images.length, 2, "Stop keeps already parsed media");
  assert.equal(result.progress.phase, "cancelled");
  assert.equal(result.profileCollection.complete, false);
  assert.match(result.warnings.join(" "), /stopped/);
  page.control(runId, "release");
  assert.equal(page.control(runId, "status"), null, "Finished progress can be released");
}

async function checkStreamingHighlights() {
  let releaseSecond;
  const page = harness((url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("highlights_tray")) return response(url, {
      tray: [101, 102, 103, 104, 105].map(id => ({ id: `highlight:${id}`, title: `Trip ${id}`, user: { username: "alice" } }))
    });
    const reelId = parsed.searchParams.get("reel_ids");
    assert.ok(reelId, "Successful API results must not fetch duplicate highlight HTML");
    const id = reelId.split(":")[1];
    const result = response(url, { reels: { [reelId]: {
      id: reelId, user: { username: "alice" }, items: [photo(id)]
    } } });
    if (id === "102") return new Promise(resolve => { releaseSecond = () => resolve(result); });
    return result;
  }, ["/stories/highlights/101/"]);
  const scan = page.collect({ runId, includeProfilePosts: false, includeHighlights: true, maxDocuments: 32 });
  await tick();
  const progress = page.control(runId, "status");
  assert.equal(progress.highlightsTotal, 5);
  assert.equal(progress.highlightsChecked, 1, "The first response is parsed before the slow response finishes");
  assert.equal(progress.highlightsLoaded, 1);
  assert.equal(progress.media, 1);
  assert.ok(page.requests.length <= 5, "At most three responses await their ordered commit");
  releaseSecond();
  const result = await scan;
  assert.deepEqual(Array.from(result.images, item => item.url), [101, 102, 103, 104, 105].map(id => photo(id).image_versions2.candidates[0].url));
  assert.equal(result.progress.highlightsChecked, 5);
  assert.equal(result.progress.highlightsLoaded, 5);
  assert.equal(result.progress.posts, 0, "Highlight media are not counted as profile posts");
  assert.equal(page.requests.length, 6, "Only one tray and five bounded reel requests are needed");
}

async function checkSupersededRun() {
  const pending = [];
  const page = harness((url, init) => new Promise(resolve => {
    pending.push({ init, finish: () => resolve(response(url, { items: [photo("101")], more_available: false })) });
    // Simulate a slow response whose transport ignores AbortSignal. Its result
    // must still be rejected after cancellation.
  }));
  const first = page.collect({ runId, includeProfileReels: false });
  await tick();
  const secondId = "instagram-progress-test-0002";
  const second = page.collect({ runId: secondId, includeProfileReels: false });
  await tick();
  assert.equal(pending[0].init.signal.aborted, true);
  page.control(runId, "cancel");
  page.control(runId, "release");
  assert.equal(pending[1].init.signal.aborted, false, "An old manager cannot cancel or release the new run");
  pending[0].finish();
  const oldResult = await first;
  assert.equal(oldResult.images.length, 0, "Late responses from an aborted transport are ignored");
  pending[1].finish();
  const newResult = await second;
  assert.equal(newResult.images.length, 1);
  assert.equal(newResult.progress.phase, "complete");
}

async function checkIncompleteHighlightFallback() {
  let htmlRequests = 0;
  const page = harness(url => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("highlights_tray")) return response(url, {
      tray: [{ id: "highlight:101", title: "Trip", user: { username: "alice" } }]
    });
    const reel = { id: "highlight:101", user: { username: "alice" }, items: [photo("1"), photo("2")] };
    if (parsed.pathname === "/stories/highlights/101/") {
      htmlRequests += 1;
      return { ok: true, url, headers: { get: () => "text/html" },
        text: async () => `<script type="application/json">${JSON.stringify({ reels: { "highlight:101": reel } })}</script>` };
    }
    reel.items[1] = { pk: "2", media_type: 2, video_url: "https://scontent.cdninstagram.com/stream.m3u8" };
    return response(url, { reels: { "highlight:101": reel } });
  }, ["/stories/highlights/101/"]);
  const result = await page.collect({ runId, includeProfilePosts: false, includeHighlights: true });
  assert.equal(htmlRequests, 1, "Partial API results retain the exact highlight HTML fallback");
  assert.equal(result.images.length, 2, "Duplicate-request optimization must preserve unresolved media");
}

(async () => {
  await checkProgressAndCancel();
  await checkStreamingHighlights();
  await checkSupersededRun();
  await checkIncompleteHighlightFallback();
  console.log("Instagram progress, streaming, cancellation and supersession checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
