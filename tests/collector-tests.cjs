"use strict";

const assert = require("assert").strict;
const exportedCollector = require("../extension/shared/collector.js");

assert.equal(
  typeof exportedCollector,
  "function",
  "shared/collector.js must export collectImagesFromPage"
);

// Firefox serializes executeScript.func instead of carrying its outer closure.
// Exercise that same standalone function form throughout these fixtures.
const collectImagesFromPage = new Function(`return (${exportedCollector.toString()});`)();

const PAGE_URL = "https://gallery.test/albums/example";

function absoluteUrl(value, base = PAGE_URL) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value, base).href;
  } catch (_error) {
    return String(value);
  }
}

function dataPropertyName(attributeName) {
  return attributeName
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSelector(element, rawSelector) {
  const selectors = String(rawSelector || "")
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);

  return selectors.some((selector) => {
    selector = selector.replace(/^:scope\s*>\s*/, "").trim();
    const tagMatch = selector.match(/^[a-z][a-z0-9-]*/i);
    if (tagMatch && element.localName !== tagMatch[0].toLowerCase()) {
      return false;
    }

    const attributePattern = /\[([^\]^=\s]+)\s*(?:(\^?=)\s*["']?([^\]"']*)["']?)?\]/g;
    let attributeMatch;
    while ((attributeMatch = attributePattern.exec(selector))) {
      const name = attributeMatch[1].toLowerCase();
      if (!element.hasAttribute(name)) {
        return false;
      }
      if (!attributeMatch[2]) {
        continue;
      }
      const actual = element.getAttribute(name);
      const expected = attributeMatch[3];
      if (attributeMatch[2] === "=" && actual !== expected) {
        return false;
      }
      if (attributeMatch[2] === "^=" && !actual.startsWith(expected)) {
        return false;
      }
    }
    return true;
  });
}

class FakeElement {
  constructor(tagName, attributes = {}, properties = {}, children = []) {
    this.localName = String(tagName).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeType = 1;
    this.namespaceURI = properties.namespaceURI || "http://www.w3.org/1999/xhtml";
    this.parentElement = null;
    this.parentNode = null;
    this.ownerDocument = null;
    this.children = [];
    this.childNodes = this.children;
    this.shadowRoot = properties.shadowRoot || null;
    this.naturalWidth = Number(properties.naturalWidth) || 0;
    this.naturalHeight = Number(properties.naturalHeight) || 0;
    this.clientWidth = Number(properties.clientWidth) || 0;
    this.clientHeight = Number(properties.clientHeight) || 0;
    this.width = Number(properties.width) || 0;
    this.height = Number(properties.height) || 0;
    this.videoWidth = Number(properties.videoWidth) || 0;
    this.videoHeight = Number(properties.videoHeight) || 0;
    this.duration = Number(properties.duration) || 0;
    this._currentSrc = properties.currentSrc || "";
    this._attributes = new Map();

    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
    for (const child of children) {
      this.appendChild(child);
    }
  }

  get attributes() {
    return Array.from(this._attributes, ([name, value]) => ({ name, value }));
  }

  get dataset() {
    const result = {};
    for (const [name, value] of this._attributes) {
      if (name.startsWith("data-")) {
        result[dataPropertyName(name)] = value;
      }
    }
    return result;
  }

  get alt() {
    return this.getAttribute("alt") || "";
  }

  get currentSrc() {
    return this._currentSrc ? absoluteUrl(this._currentSrc, this.baseURI) : "";
  }

  get src() {
    return absoluteUrl(this.getAttribute("src"), this.baseURI);
  }

  get srcset() {
    return this.getAttribute("srcset") || "";
  }

  get href() {
    return absoluteUrl(this.getAttribute("href"), this.baseURI);
  }

  get poster() {
    return absoluteUrl(this.getAttribute("poster"), this.baseURI);
  }

  get type() {
    return this.getAttribute("type") || "";
  }

  get rel() {
    return this.getAttribute("rel") || "";
  }

  get download() {
    return this.getAttribute("download") || "";
  }

  get previousElementSibling() {
    if (!this.parentElement) {
      return null;
    }
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }

  get nextElementSibling() {
    if (!this.parentElement) {
      return null;
    }
    const index = this.parentElement.children.indexOf(this);
    return index >= 0 && index + 1 < this.parentElement.children.length
      ? this.parentElement.children[index + 1]
      : null;
  }

  get baseURI() {
    return this.ownerDocument ? this.ownerDocument.baseURI : PAGE_URL;
  }

  setAttribute(name, value) {
    this._attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const value = this._attributes.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }

  hasAttribute(name) {
    return this._attributes.has(String(name).toLowerCase());
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const directChildrenOnly = /^:scope\s*>/.test(String(selector));
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) {
          matches.push(child);
        }
        if (!directChildrenOnly) {
          visit(child);
        }
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return {
      width: this.clientWidth || this.width || 0,
      height: this.clientHeight || this.height || 0,
      top: 0,
      right: this.clientWidth || this.width || 0,
      bottom: this.clientHeight || this.height || 0,
      left: 0
    };
  }
}

function assignOwnerDocument(element, document) {
  element.ownerDocument = document;
  for (const child of element.children) {
    assignOwnerDocument(child, document);
  }
  if (element.shadowRoot) {
    element.shadowRoot.ownerDocument = document;
  }
}

function descendantElements(root) {
  const result = [];
  const visit = (element) => {
    result.push(element);
    for (const child of element.children || []) {
      visit(child);
    }
  };

  if (root instanceof FakeDocument) {
    visit(root.documentElement);
  } else {
    for (const child of root.children || []) {
      visit(child);
    }
  }
  return result;
}

class FakeDocument {
  constructor(elements, url = PAGE_URL) {
    this.nodeType = 9;
    this.baseURI = url;
    this.URL = url;
    this.title = "Collector fixture";
    this.location = { href: url };
    this.body = new FakeElement("body", {}, {}, elements);
    this.documentElement = new FakeElement("html", {}, {}, [this.body]);
    assignOwnerDocument(this.documentElement, this);
    this.defaultView = {
      document: this,
      location: this.location,
      matchMedia(query) {
        const text = String(query || "");
        return {
          matches: !/5000px|99999px/.test(text),
          media: text,
          addEventListener() {},
          removeEventListener() {}
        };
      }
    };
  }

  createTreeWalker(root) {
    const elements = descendantElements(root);
    let index = 0;
    return {
      nextNode() {
        return elements[index++] || null;
      }
    };
  }

  querySelectorAll(selector) {
    return descendantElements(this).filter((element) => matchesSelector(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    assignOwnerDocument(element, this);
    return element;
  }
}

function element(tagName, attributes, properties, children) {
  return new FakeElement(tagName, attributes, properties, children);
}

function withFakePage(elements, callback, url = PAGE_URL) {
  const document = new FakeDocument(elements, url);
  const replacements = {
    document,
    location: document.location,
    window: document.defaultView,
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle() {
      return {
        backgroundImage: "none",
        borderImageSource: "none",
        listStyleImage: "none",
        maskImage: "none",
        webkitMaskImage: "none"
      };
    },
    matchMedia: document.defaultView.matchMedia
  };
  const previous = new Map();

  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, {
      existed: Object.prototype.hasOwnProperty.call(globalThis, name),
      value: globalThis[name]
    });
    globalThis[name] = value;
  }

  try {
    return callback(document);
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

function scan(elements, options = {}, url = PAGE_URL) {
  return withFakePage(elements, () => collectImagesFromPage({
    includeBackgrounds: false,
    maxImages: 1500,
    maxElements: 10000,
    maxDataUrlLength: 500000,
    maxPayloadLength: 2000000,
    ...options
  }), url);
}

function urls(result) {
  return result.images.map((image) => image.url);
}

// FapFolder exposes the original image on an ancestor data-image attribute.
{
  const thumbnail = element(
    "img",
    { src: "/thumbs/42-320.jpg", alt: "Gallery image 42" },
    { currentSrc: "/thumbs/42-320.jpg", naturalWidth: 320, naturalHeight: 480 }
  );
  const card = element(
    "a",
    { href: "/photo/42", "data-image": "https://cdn.gallery.test/originals/42.jpg" },
    {},
    [thumbnail]
  );
  const result = scan([card]);

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, "https://cdn.gallery.test/originals/42.jpg");
  assert.equal(result.images[0].previewUrl, "https://gallery.test/thumbs/42-320.jpg");
  assert.equal(result.images[0].width, 0, "original width must not reuse thumbnail dimensions");
  assert.equal(result.images[0].height, 0, "original height must not reuse thumbnail dimensions");
  assert.ok(result.images[0].kinds.includes("Full-size image"));
}

// Explicit originals may carry their own full-size dimensions. Hints can live
// on the image itself or on its nearest metadata wrapper, but thumbnail natural
// dimensions are never substituted when those hints are absent.
{
  const sameElementResult = scan([
    element(
      "img",
      {
        src: "/dimensions/thumb-a.jpg",
        "data-original": "/dimensions/full-a.jpg",
        "data-image-width": "2400",
        "data-image-height": "3600"
      },
      { currentSrc: "/dimensions/thumb-a.jpg", naturalWidth: 240, naturalHeight: 360 }
    )
  ]);
  assert.equal(sameElementResult.images[0].width, 2400);
  assert.equal(sameElementResult.images[0].height, 3600);

  const wrappedImage = element(
    "img",
    { src: "/dimensions/thumb-b.jpg", "data-original": "/dimensions/full-b.jpg" },
    { currentSrc: "/dimensions/thumb-b.jpg", naturalWidth: 320, naturalHeight: 180 }
  );
  const nearestAncestorResult = scan([
    element(
      "figure",
      { "data-width": "4096", "data-height": "2304" },
      {},
      [wrappedImage]
    )
  ]);
  assert.equal(nearestAncestorResult.images[0].width, 4096);
  assert.equal(nearestAncestorResult.images[0].height, 2304);

  const invalidHintResult = scan([
    element(
      "img",
      {
        src: "/dimensions/thumb-c.jpg",
        "data-full": "/dimensions/full-c.jpg",
        "data-full-width": "320px",
        "data-full-height": "auto"
      },
      { currentSrc: "/dimensions/thumb-c.jpg", naturalWidth: 320, naturalHeight: 200 }
    )
  ]);
  assert.equal(invalidHintResult.images[0].width, 0);
  assert.equal(invalidHintResult.images[0].height, 0);
}

// Fapello page-2 appends thousands of four-element cards while scrolling. Its
// last photos (including the blue outfit) sit beyond the general DOM budget.
{
  const cards = [];
  for (let id = 2706; id >= 1; id -= 1) {
    const number = String(id).padStart(4, "0");
    const folder = Math.ceil(id / 1000) * 1000;
    const thumbnail = `https://fapello.com/content/o/l/olyashaa/${folder}/olyashaa_${number}_300px.jpg`;
    cards.push(element("div", {}, {}, [
      element("a", { href: `https://ru.fapello.com/olyashaa/${id}/` }, {}, [
        element("div", {}, {}, [element("img", { src: thumbnail })])
      ])
    ]));
  }
  const result = scan(cards, { maxImages: 5000 }, "https://ru.fapello.com/olyashaa/page-2/");
  assert.equal(result.images.length, 2706, "markup wrappers must not hide the end of a loaded gallery");
  assert.equal(result.images[0].url, "https://fapello.com/content/o/l/olyashaa/3000/olyashaa_2706.jpg");
  assert.equal(result.images.at(-1).url, "https://fapello.com/content/o/l/olyashaa/1000/olyashaa_0001.jpg");
  assert.equal(result.images.at(-1).previewUrl, "https://fapello.com/content/o/l/olyashaa/1000/olyashaa_0001_300px.jpg");
  assert(result.warnings.some((warning) => /Backgrounds, links and embedded frames/.test(warning)));
}

// Direct media has its own bounded pass, without expanding computed-style work
// or collecting the same image twice. Other media types share that pass.
{
  const firstImage = element("img", { src: "/first.jpg" });
  const padding = Array.from({ length: 100 }, () => element("div"));
  const shadow = element("shadow-root", {}, {}, [element("img", { src: "/shadow-tail.jpg" })]);
  const host = element("div", {}, { shadowRoot: shadow });
  const lastMedia = [
    element("img", { src: "/tail.jpg" }),
    element("video", { src: "/tail.mp4" }),
    element("image", { href: "/tail.svg" }, { namespaceURI: "http://www.w3.org/2000/svg" }),
    element("input", { type: "image", src: "/tail-input.png" })
  ];
  withFakePage([firstImage, host, ...padding, ...lastMedia], (document) => {
    let styleReads = 0;
    let walkerReads = 0;
    const createTreeWalker = document.createTreeWalker.bind(document);
    document.createTreeWalker = (...args) => {
      const walker = createTreeWalker(...args);
      return { nextNode() { walkerReads += 1; return walker.nextNode(); } };
    };
    globalThis.getComputedStyle = () => { styleReads += 1; return {}; };
    const result = collectImagesFromPage({ maxImages: 5000, maxElements: 20 });
    assert.deepEqual(result.images.map((item) => item.url), [
      "https://gallery.test/first.jpg",
      "https://gallery.test/tail.jpg",
      "https://gallery.test/tail.mp4",
      "https://gallery.test/tail.svg",
      "https://gallery.test/tail-input.png",
      "https://gallery.test/shadow-tail.jpg"
    ]);
    assert.equal(styleReads, 20, "supplemental direct media must not expand the style budget");
    assert.equal(walkerReads, 21, "general traversal must still stop at its original budget");
  });

  const limited = scan(Array.from({ length: 5 }, (_unused, index) =>
    element("img", { src: `/bounded-${index}.jpg` })
  ), { maxElements: 3 });
  assert.equal(limited.images.length, 3, "the direct-media pass must also have a finite budget");
  assert(limited.warnings.some((warning) => /first 3 direct media elements/.test(warning)));
}

// Known gallery/CDN wrappers are upgraded only on their narrowly matched hosts
// and paths. The displayed resource remains available as the cheap popup preview.
{
  const fapFolderThumbnail = "https://fap.onl/uploads/preview/2026/08/Fap_hash_middle.webp";
  const fapFolderResult = scan([
    element("img", { src: fapFolderThumbnail }, { currentSrc: fapFolderThumbnail })
  ]);
  assert.equal(
    fapFolderResult.images[0].url,
    "https://fap.onl/uploads/photos/2026/08/Fap_hash.webp"
  );
  assert.equal(fapFolderResult.images[0].previewUrl, fapFolderThumbnail);

  const fapelloResult = scan([
    element(
      "img",
      { src: "https://cdn.fapello.com/content/l/a/model/1000/model_0001_300px.jpg" },
      { currentSrc: "https://cdn.fapello.com/content/l/a/model/1000/model_0001_300px.jpg" }
    )
  ]);
  assert.equal(
    fapelloResult.images[0].url,
    "https://cdn.fapello.com/content/l/a/model/1000/model_0001.jpg"
  );

  const nextResult = scan([
    element(
      "img",
      { src: "/_next/image?url=%2Fmedia%2Foriginal.jpg&w=320&q=75" },
      { currentSrc: "/_next/image?url=%2Fmedia%2Foriginal.jpg&w=320&q=75" }
    )
  ]);
  assert.equal(nextResult.images[0].url, "https://gallery.test/media/original.jpg");

  const arbitraryQueryResult = scan([
    element(
      "img",
      { src: "https://images.test/render?id=42&width=320" },
      { currentSrc: "https://images.test/render?id=42&width=320" }
    )
  ]);
  assert.equal(
    arbitraryQueryResult.images[0].url,
    "https://images.test/render?id=42&width=320"
  );
}

// Width and density candidates are ranked numerically rather than by source order.
{
  const widthResult = scan([
    element(
      "img",
      {
        src: "/responsive/thumb.jpg",
        srcset: "/responsive/1600.jpg 1600w, /responsive/320.jpg 320w, /responsive/800.jpg 800w"
      },
      { currentSrc: "/responsive/320.jpg", naturalWidth: 320, naturalHeight: 180 }
    )
  ]);
  assert.deepEqual(urls(widthResult), ["https://gallery.test/responsive/1600.jpg"]);
  assert.equal(widthResult.images[0].width, 1600);
  assert.equal(widthResult.images[0].height, 0, "a thumbnail aspect ratio is not full-size metadata");

  const densityResult = scan([
    element(
      "img",
      {
        src: "/density/1x.jpg",
        srcset: "/density/2x.jpg 2x, /density/1x.jpg 1x, /density/3x.jpg 3x"
      },
      { currentSrc: "/density/1x.jpg", naturalWidth: 400, naturalHeight: 300 }
    )
  ]);
  assert.deepEqual(urls(densityResult), ["https://gallery.test/density/3x.jpg"]);

  const competingSetsResult = scan([
    element(
      "img",
      {
        src: "/responsive/thumb.jpg",
        srcset: "/responsive/1600.jpg 1600w, /responsive/800.jpg 800w",
        "data-srcset": "/responsive/300.jpg 300w"
      },
      { currentSrc: "/responsive/800.jpg" }
    )
  ]);
  assert.deepEqual(urls(competingSetsResult), ["https://gallery.test/responsive/1600.jpg"]);
}

// Lazy srcsets use the same ranking rules as normal srcsets.
{
  const result = scan([
    element(
      "img",
      {
        src: "/lazy/placeholder.jpg",
        "data-srcset": "/lazy/1200.webp 1200w, /lazy/300.webp 300w, /lazy/700.webp 700w"
      },
      { currentSrc: "/lazy/placeholder.jpg", naturalWidth: 300, naturalHeight: 200 }
    )
  ]);
  assert.deepEqual(urls(result), ["https://gallery.test/lazy/1200.webp"]);
}

// Only the active picture source set should be upgraded; an inactive art-directed
// source must not win merely because it has a larger width descriptor.
{
  const inactive = element("source", {
    media: "(min-width: 5000px)",
    srcset: "/picture/unrelated-5000.jpg 5000w, /picture/unrelated-1000.jpg 1000w"
  });
  const active = element("source", {
    media: "(min-width: 1px)",
    srcset: "/picture/active-640.avif 640w, /picture/active-2400.avif 2400w"
  });
  const fallback = element(
    "img",
    { src: "/picture/fallback-320.jpg" },
    { currentSrc: "/picture/active-640.avif", naturalWidth: 640, naturalHeight: 360 }
  );
  const result = scan([element("picture", {}, {}, [inactive, active, fallback])]);
  assert.deepEqual(urls(result), ["https://gallery.test/picture/active-2400.avif"]);
}

// A wrapping link is promoted only when its URL is recognizably an image.
{
  const directImage = element(
    "a",
    { href: "/original/photo.webp?download=1" },
    {},
    [element("img", { src: "/thumb/photo.webp" }, { currentSrc: "/thumb/photo.webp" })]
  );
  const navigation = element(
    "a",
    { href: "/gallery/photo/42" },
    {},
    [element("img", { src: "/thumb/42.jpg" }, { currentSrc: "/thumb/42.jpg" })]
  );
  const result = scan([directImage, navigation]);

  assert.deepEqual(urls(result), [
    "https://gallery.test/original/photo.webp?download=1",
    "https://gallery.test/thumb/42.jpg"
  ]);
  assert.ok(!urls(result).includes("https://gallery.test/gallery/photo/42"));
}

// A context-menu target ID limits collection to the exact clicked image while
// retaining ancestor-based original resolution. A stale ID falls back to the
// ordinary page scan.
{
  const firstImage = element(
    "img",
    { src: "/target/first-thumb.jpg" },
    { currentSrc: "/target/first-thumb.jpg" }
  );
  const firstCard = element(
    "a",
    { "data-image": "/target/first-full.jpg" },
    {},
    [firstImage]
  );
  const secondImage = element(
    "img",
    { src: "/target/second-thumb.jpg" },
    { currentSrc: "/target/second-thumb.jpg" }
  );
  const secondCard = element(
    "a",
    {
      "data-image": "/target/second-full.jpg",
      "data-image-width": "3000",
      "data-image-height": "2000"
    },
    {},
    [secondImage]
  );
  const hadBrowser = Object.prototype.hasOwnProperty.call(globalThis, "browser");
  const previousBrowser = globalThis.browser;
  let requestedTargetId = null;

  try {
    globalThis.browser = {
      menus: {
        getTargetElement(targetElementId) {
          requestedTargetId = targetElementId;
          return targetElementId === 73 ? secondImage : null;
        }
      }
    };

    const targetedResult = scan([firstCard, secondCard], { targetElementId: 73 });
    assert.equal(requestedTargetId, 73);
    assert.deepEqual(urls(targetedResult), ["https://gallery.test/target/second-full.jpg"]);
    assert.equal(targetedResult.images[0].previewUrl, "https://gallery.test/target/second-thumb.jpg");
    assert.equal(targetedResult.images[0].width, 3000);
    assert.equal(targetedResult.images[0].height, 2000);

    const fallbackResult = scan([firstCard, secondCard], { targetElementId: 404 });
    assert.deepEqual(urls(fallbackResult), [
      "https://gallery.test/target/first-full.jpg",
      "https://gallery.test/target/second-full.jpg"
    ]);
  } finally {
    if (hadBrowser) {
      globalThis.browser = previousBrowser;
    } else {
      delete globalThis.browser;
    }
  }
}

// An unsafe explicit original must not displace a valid ordinary source.
{
  const result = scan([
    element(
      "img",
      { src: "/safe/fallback.jpg", "data-original": "javascript:alert(1)" },
      { currentSrc: "/safe/fallback.jpg", naturalWidth: 640, naturalHeight: 480 }
    )
  ]);
  assert.deepEqual(urls(result), ["https://gallery.test/safe/fallback.jpg"]);
}

// A plain image remains unchanged.
{
  const result = scan([
    element(
      "img",
      { src: "/plain/photo.jpg", alt: "Plain photo" },
      { currentSrc: "/plain/photo.jpg", naturalWidth: 1024, naturalHeight: 768 }
    )
  ]);
  assert.deepEqual(urls(result), ["https://gallery.test/plain/photo.jpg"]);
  assert.equal(result.images[0].width, 1024);
  assert.equal(result.images[0].height, 768);
}

// Repeated hints and repeated elements deduplicate the resolved original URL.
{
  const fullUrl = "https://cdn.gallery.test/full/shared.jpg";
  const first = element(
    "a",
    { "data-image": fullUrl, href: fullUrl },
    {},
    [element("img", { src: "/thumb/a.jpg", "data-original": fullUrl }, { currentSrc: "/thumb/a.jpg" })]
  );
  const second = element(
    "a",
    { "data-image": fullUrl },
    {},
    [element("img", { src: "/thumb/b.jpg" }, { currentSrc: "/thumb/b.jpg" })]
  );
  const result = scan([first, second]);
  assert.deepEqual(urls(result), [fullUrl]);
}

// Candidate resolution happens before the image-count limit is consumed, so a
// thumbnail cannot take the one available slot ahead of its original.
{
  const result = scan(
    [
      element(
        "img",
        { src: "/limit/thumb.jpg", "data-original": "/limit/original.jpg" },
        { currentSrc: "/limit/thumb.jpg" }
      ),
      element("img", { src: "/limit/second.jpg" }, { currentSrc: "/limit/second.jpg" })
    ],
    { maxImages: 1 }
  );
  assert.deepEqual(urls(result), ["https://gallery.test/limit/original.jpg"]);
  assert.ok(result.warnings.some((warning) => /limit|first 1|1 distinct/i.test(warning)));
}

// A direct video element prefers its browser-selected currentSrc, retains its
// poster as a lightweight preview, and exposes useful playback metadata.
{
  const fallbackSource = element("source", {
    src: "/videos/fallback.webm",
    type: "video/webm"
  });
  const result = scan([
    element(
      "video",
      {
        src: "/videos/element.mp4",
        poster: "/posters/feature.jpg",
        "aria-label": "Feature trailer"
      },
      {
        currentSrc: "/videos/current.mp4?token=abc",
        videoWidth: 1920,
        videoHeight: 1080,
        duration: 65.4
      },
      [fallbackSource]
    )
  ]);
  const video = result.images.find((item) => item.mediaType === "video");
  const poster = result.images.find((item) => item.mediaType === "image");

  assert.ok(video, "The selected direct video source must be collected");
  assert.equal(video.url, "https://gallery.test/videos/current.mp4?token=abc");
  assert.equal(video.previewUrl, "https://gallery.test/posters/feature.jpg");
  assert.equal(video.alt, "Feature trailer");
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.duration, 65.4);
  assert.equal(video.mimeType, "video/mp4");
  assert.ok(video.kinds.includes("Video"));
  assert.ok(poster, "A video poster must remain available as an ordinary image too");
  assert.equal(poster.url, "https://gallery.test/posters/feature.jpg");
}

// Child <source> URLs and clearly direct linked files are collected when a
// video element itself has no selected source.
{
  const result = scan([
    element("video", {}, {}, [
      element("source", { src: "/videos/source-only.webm", type: "video/webm" })
    ]),
    element("a", {
      href: "/downloads/behind-scenes.MOV?signature=keep",
      download: "behind-scenes.mov",
      type: "video/quicktime",
      "aria-label": "Behind the scenes"
    }),
    element("a", {
      href: "/api/direct-video?id=9&token=keep",
      type: "application/mp4",
      "aria-label": "Extensionless MP4"
    })
  ]);
  const videos = result.images.filter((item) => item.mediaType === "video");

  assert.deepEqual(videos.map((item) => item.url), [
    "https://gallery.test/videos/source-only.webm",
    "https://gallery.test/downloads/behind-scenes.MOV?signature=keep",
    "https://gallery.test/api/direct-video?id=9&token=keep"
  ]);
  assert.equal(videos[0].mimeType, "video/webm");
  assert.ok(videos[0].kinds.includes("Video source"));
  assert.equal(videos[1].mimeType, "video/quicktime");
  assert.ok(videos[1].kinds.includes("Linked video"));
  assert.equal(videos[2].mimeType, "application/mp4");
  assert.ok(videos[2].kinds.includes("Linked video"));
}

// Lazy-loading attributes on video sources are resolved without waiting for
// playback, and a lazy poster is retained as the preview URL.
{
  const result = scan([
    element("video", { "data-poster": "/posters/lazy.jpg" }, {}, [
      element("source", {
        "data-src": "/videos/lazy-source.m4v?token=keep",
        type: "video/x-m4v"
      })
    ])
  ]);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, "video");
  assert.equal(result.images[0].url, "https://gallery.test/videos/lazy-source.m4v?token=keep");
  assert.equal(result.images[0].previewUrl, "https://gallery.test/posters/lazy.jpg");
  assert.equal(result.images[0].mimeType, "video/x-m4v");
  assert.ok(result.images[0].kinds.includes("Lazy video source"));
}

// Bounded embedded videos are valid direct media. Page-owned blobs and HLS or
// DASH manifests are intentionally skipped because they are not standalone files.
{
  const embedded = scan([
    element("video", { src: "data:video/mp4;base64,AA==" })
  ]);
  assert.equal(embedded.images.length, 1);
  assert.equal(embedded.images[0].mediaType, "video");
  assert.equal(embedded.images[0].url, "data:video/mp4;base64,AA==");
  assert.equal(embedded.images[0].mimeType, "video/mp4");

  const skipped = scan([
    element("video", { src: "blob:https://gallery.test/page-owned" }),
    element("video", { src: "/stream/live.m3u8" }),
    element("video", {}, {}, [
      element("source", { src: "/stream/manifest.mpd", type: "application/dash+xml" })
    ]),
    element("video", {}, {}, [
      element("source", {
        src: "/stream/extensionless",
        type: "application/vnd.apple.mpegurl"
      })
    ])
  ]);
  assert.equal(skipped.images.length, 0);
  assert.ok(skipped.warnings.some((warning) => /blob video URL/i.test(warning)));
  assert.ok(skipped.warnings.some((warning) => /streaming video manifest/i.test(warning)));
}

// A Firefox context-menu target can limit collection to the exact clicked
// video, just as it already does for images.
{
  const firstVideo = element("video", { src: "/target/first.mp4" });
  const secondVideo = element("video", { src: "/target/second.webm" });
  const hadBrowser = Object.prototype.hasOwnProperty.call(globalThis, "browser");
  const previousBrowser = globalThis.browser;

  try {
    globalThis.browser = {
      menus: {
        getTargetElement(targetElementId) {
          return targetElementId === 74 ? secondVideo : null;
        }
      }
    };
    const targeted = scan([firstVideo, secondVideo], { targetElementId: 74 });
    assert.deepEqual(urls(targeted), ["https://gallery.test/target/second.webm"]);
    assert.equal(targeted.images[0].mediaType, "video");
  } finally {
    if (hadBrowser) {
      globalThis.browser = previousBrowser;
    } else {
      delete globalThis.browser;
    }
  }
}

withFakePage([element("img", { src: "/current.jpg" })], () => {
  const nextUrl = "https://gallery.test/next/page";
  const nextDocument = new FakeDocument([
    element("img", { src: "thumb.jpg", "data-original": "full.jpg" }),
    element("video", { src: "clip.mp4" })
  ], nextUrl);
  const result = collectImagesFromPage({ pageUrl: nextUrl, includeBackgrounds: false }, nextDocument);
  assert.deepEqual(urls(result), ["https://gallery.test/next/full.jpg", "https://gallery.test/next/clip.mp4"]);
  assert.equal(result.pageUrl, nextUrl, "Fetched gallery pages must use their own document and base URL");
});

// Telegram keeps actual media in page-owned blobs and SW progressive URLs.
{
  const photoUrl = "blob:https://web.telegram.org/01234567-abcd-1234-abcd-012345678901";
  const photo = element("img", { src: photoUrl }, { naturalWidth: 1200, naturalHeight: 800 });
  photo.closest = (selector) => selector.includes(".bubble") ? photo : null;
  const avatar = element("img", { src: "blob:https://web.telegram.org/avatar" });
  avatar.closest = () => avatar;
  const stream = "https://web.telegram.org/k/stream/%7B%22id%22%3A1%7D";
  const video = element("video", { src: stream });
  const hls = element("video", { src: "https://web.telegram.org/k/hls/playlist" });
  withFakePage([photo, avatar, video, hls], () => {
    const result = collectImagesFromPage();
    assert.deepEqual(urls(result), [photoUrl, stream]);
    assert.equal(result.images[0].width, 1200);
    assert.equal(result.images[1].mediaType, "video");
    assert(result.warnings.some((warning) => warning.includes("Keep this Telegram tab")));
  }, "https://web.telegram.org/k/#-123");
  withFakePage([photo], () => {
    assert.equal(collectImagesFromPage().images.length, 0, "Other sites cannot collect Telegram blobs");
  });
}

console.log("All collector fixture checks passed.");
