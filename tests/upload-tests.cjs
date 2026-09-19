"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const Uploads = require("../extension/shared/uploads.js");
const Immich = require("../extension/shared/immich.js");
const ownerId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
const albumId = "00000000-0000-4000-8000-000000000003";
const assetId = "00000000-0000-4000-8000-000000000004";
const serverUrl = "https://photos.tail123.ts.net:2283";
const credential = { serverUrl, apiKey: "a-test-secret-never-store" };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const blob = new Blob([png], { type: "image/png" });
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const videoBlob = new Blob([mp4], { type: "video/mp4" });
const create = (count = 1, options = {}) => Uploads.createJob(Array.from({ length: count }, (_, index) => ({
  url: `https://source.example/photo-${index}.png`, filename: `photo-${index}.png`, downloaded: true, apiKey: credential.apiKey
})), { ownerId, connectionId, serverUrl, id: "test-upload-job", ...options });
const copy = (value) => JSON.parse(JSON.stringify(value));

async function main() {
  const source = fs.readFileSync(path.join(__dirname, "../extension/shared/uploads.js"), "utf8");
  assert.doesNotMatch(source, /\bbrowser\s*\.|download-ledger|downloadFingerprint|storage\.local/,
    "Remote upload results never modify the local download ledger or storage directly");
  const fresh = create();
  assert.equal(fresh.status, "queued");
  assert.equal(fresh.items[0].uploadStatus, "pending");
  assert.equal(fresh.items[0].albumStatus, "none");
  assert.ok(!JSON.stringify(fresh).includes(credential.apiKey));
  assert.equal(fresh.items[0].downloaded, undefined);
  for (const options of [{ ownerId: "" }, { ownerId: 123 }, { incognito: true }, { connectionId: "bad" }, { albumId: "bad" }, { provider: "drive" }]) {
    assert.throws(() => create(1, options), { code: "invalid_job" });
  }
  assert.throws(() => create(Uploads.MAX_ITEMS + 1), { code: "invalid_job" });
  const video = Uploads.createJob([{ url: "https://source.example/file.mp4", filename: "file.mp4", mediaType: "video" }], fresh);
  assert.equal(video.items[0].mediaType, "video");
  assert.throws(() => Uploads.createJob([{ url: "data:image/png;base64,AAAA" }], fresh), { code: "embedded_image" });
  assert.throws(() => Uploads.createJob([{ url: "https://user:password@source.example/photo.png" }], fresh), { code: "invalid_job" });

  let uploads = 0;
  let attachments = 0;
  let fetching = 0;
  let activeUploads = 0;
  let snapshots = [];
  const provider = {
    async uploadAsset(key, asset, { signal }) {
      assert.equal(key, credential);
      assert.equal(signal.aborted, false);
      assert.ok(asset.blob instanceof Blob);
      activeUploads += 1;
      assert.equal(activeUploads, 1, "Images upload sequentially");
      await Promise.resolve();
      activeUploads -= 1;
      uploads += 1;
      return { assetId, duplicate: false };
    },
    async addToAlbum(key, album, id) {
      attachments += 1;
      assert.equal(key, credential);
      assert.equal(album, albumId);
      assert.equal(id, assetId);
    }
  };
  const options = {
    credential, provider,
    onChange: async (job) => {
      assert.ok(!JSON.stringify(job).includes(credential.apiKey));
      snapshots.push(copy(job));
    },
    fetchImage: async () => { fetching += 1; return blob; }
  };
  const library = create(2);
  await Uploads.run(library, options);
  assert.equal(library.status, "complete");
  assert.equal(uploads, 2);
  assert.equal(fetching, 2);
  assert.equal(attachments, 0, "Library uploads make no album calls or require album access");
  assert.equal(Uploads.summarize(library).complete, 2);
  assert.equal(Uploads.summarize(library).uploaded, 2);
  assert.equal(Uploads.summarize(library).attached, 0);
  await Uploads.run(library, options);
  assert.equal(uploads, 2, "An explicit retry leaves confirmed completed images alone");

  uploads = 0;
  await Uploads.run(video, { ...options, fetchImage: async () => videoBlob });
  assert.equal(video.status, "complete", "Direct videos use the same durable Immich asset pipeline");
  assert.equal(video.items[0].mediaType, "video");

  uploads = 0; attachments = 0; snapshots = [];
  const album = create(1, { albumId });
  await Uploads.run(album, options);
  assert.equal(uploads, 1);
  assert.equal(attachments, 1);
  assert.equal(album.status, "complete");
  const beforeAttachment = snapshots.find((job) => job.items[0].albumStatus === "attaching");
  assert.equal(beforeAttachment.items[0].assetId, assetId, "Persist asset identity before album attachment");
  assert.equal(beforeAttachment.items[0].uploadStatus, "complete");
  assert.equal(Uploads.summarize(beforeAttachment).complete, 0, "Asset upload alone does not complete an album operation");

  uploads = 0; attachments = 0;
  const duplicate = create(1, { albumId });
  await Uploads.run(duplicate, { ...options, provider: {
    ...provider, uploadAsset: async () => { uploads += 1; return { assetId, duplicate: true }; }
  } });
  assert.equal(duplicate.status, "complete");
  assert.equal(duplicate.items[0].duplicate, true);
  assert.equal(attachments, 1, "Duplicate assets still need album attachment");

  uploads = 0; fetching = 0; attachments = 0;
  const partialAlbum = create(1, { albumId });
  await Uploads.run(partialAlbum, { ...options, provider: {
    ...provider, addToAlbum: async () => { throw new Immich.ImmichError("album_failed"); }
  } });
  assert.equal(partialAlbum.status, "partial");
  assert.equal(partialAlbum.items[0].assetId, assetId);
  assert.equal(partialAlbum.items[0].uploadStatus, "complete");
  assert.equal(partialAlbum.items[0].albumStatus, "failed");
  const retry = Uploads.recoverJob(copy(partialAlbum));
  await Uploads.run(retry, options);
  assert.equal(retry.status, "complete");
  assert.equal(uploads, 1, "Retry only album attachment after successful upload");
  assert.equal(fetching, 1, "Retry album attachment without re-fetching source bytes");
  assert.equal(attachments, 1);

  for (const code of ["invalid_key", "missing_upload_permission", "forbidden", "rejected"]) {
    const failed = create();
    await Uploads.run(failed, { ...options, provider: {
      ...provider, uploadAsset: async () => { throw new Immich.ImmichError(code); }
    } });
    assert.equal(failed.status, "partial");
    assert.equal(failed.items[0].uploadStatus, "failed");
    assert.equal(failed.items[0].errorCode, code);
  }
  const uncertain = create();
  await Uploads.run(uncertain, { ...options, provider: {
    ...provider, uploadAsset: async () => { throw new Immich.ImmichError("unreachable", true); }
  } });
  assert.equal(uncertain.items[0].uploadStatus, "uncertain");
  assert.equal(uncertain.items[0].errorCode, "uncertain");
  assert.equal(Uploads.summarize(uncertain).complete, 0);
  await Uploads.run(uncertain, { ...options, provider: { ...provider, uploadAsset: async () => ({ assetId, duplicate: true }) } });
  assert.equal(uncertain.status, "complete");
  assert.equal(uncertain.items[0].duplicate, true);

  const partial = create(3);
  let fetchNumber = 0;
  await Uploads.run(partial, { ...options, fetchImage: async () => {
    fetchNumber += 1;
    if (fetchNumber === 2) throw Object.assign(new Error(credential.apiKey), { code: credential.apiKey });
    return { bytes: png, contentType: "image/png" };
  } });
  assert.equal(partial.status, "partial");
  assert.equal(Uploads.summarize(partial).complete, 2);
  assert.equal(Uploads.summarize(partial).failed, 1);
  assert.ok(!JSON.stringify(partial).includes(credential.apiKey));
  assert.ok(!Uploads.errorMessage(partial.items[1].errorCode).includes(credential.apiKey));
  fetchNumber = 0;
  await Uploads.run(partial, { ...options, fetchImage: async () => { fetchNumber += 1; return blob; } });
  assert.equal(fetchNumber, 1, "Partial retries only fetch unfinished images");
  assert.equal(partial.status, "complete");

  for (const phase of ["fetch", "upload", "album"]) {
    const controller = new AbortController();
    const cancelled = create(2, { albumId });
    const cancellationOptions = {
      ...options, signal: controller.signal,
      fetchImage: async () => { if (phase === "fetch") controller.abort(); return blob; },
      provider: {
        uploadAsset: async () => {
          if (phase === "upload") { controller.abort(); throw new Immich.ImmichError("cancelled", true); }
          return { assetId, duplicate: false };
        },
        addToAlbum: async () => { if (phase === "album") { controller.abort(); throw new Immich.ImmichError("cancelled", true); } }
      }
    };
    await Uploads.run(cancelled, cancellationOptions);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(Uploads.summarize(cancelled).complete, 0);
    assert.equal(cancelled.items[1].uploadStatus, "pending");
    assert.equal(cancelled.items[0].uploadStatus, phase === "upload" ? "uncertain" : phase === "fetch" ? "cancelled" : "complete");
    if (phase === "album") assert.equal(cancelled.items[0].assetId, assetId);
    await Uploads.run(cancelled, options);
    assert.equal(cancelled.status, "complete");
  }

  for (const phase of ["fetching", "uploading", "attaching"]) {
    const interrupted = create(1, { albumId });
    interrupted.status = "running";
    if (phase === "attaching") {
      Object.assign(interrupted.items[0], { assetId, uploadStatus: "complete", albumStatus: "attaching" });
    } else interrupted.items[0].uploadStatus = phase;
    interrupted.apiKey = credential.apiKey;
    interrupted.items[0].error = credential.apiKey;
    const recovered = Uploads.recoverJob(interrupted);
    assert.equal(recovered.status, "interrupted");
    assert.ok(!JSON.stringify(recovered).includes(credential.apiKey));
    assert.equal(recovered.items[0].uploadStatus, phase === "uploading" ? "uncertain" : phase === "fetching" ? "pending" : "complete");
    if (phase === "attaching") assert.equal(recovered.items[0].assetId, assetId);
  }
  const falseComplete = create();
  falseComplete.status = "complete";
  assert.equal(Uploads.recoverJob(falseComplete).status, "interrupted");
  falseComplete.items[0].uploadStatus = "complete";
  assert.throws(() => Uploads.recoverJob(falseComplete), { code: "invalid_job" });

  for (const wrongCredential of [{ ...credential, serverUrl: "https://other.example" }, { ...credential, ownerId: "other-user" }, { ...credential, connectionId: albumId }]) {
    await assert.rejects(Uploads.run(create(), { ...options, credential: wrongCredential }), { code: "wrong_connection" });
  }
  let uploadCalled = false;
  await assert.rejects(Uploads.run(create(), { ...options, onChange: async () => { throw new Error(credential.apiKey); },
    provider: { ...provider, uploadAsset: async () => { uploadCalled = true; } }
  }), (error) => error.code === "checkpoint_failed" && !error.message.includes(credential.apiKey));
  assert.equal(uploadCalled, false, "Failed durable checkpoints stop network mutations");
  let albumCalled = false;
  const checkpoint = create(1, { albumId });
  await assert.rejects(Uploads.run(checkpoint, { ...options,
    onChange: async (job) => { if (job.items[0].assetId) throw new Error(credential.apiKey); },
    provider: { ...provider, addToAlbum: async () => { albumCalled = true; } }
  }), { code: "checkpoint_failed" });
  assert.equal(albumCalled, false);
  assert.equal(checkpoint.items[0].assetId, assetId);
  assert.equal(checkpoint.status, "interrupted");

  const file = new File([png], "local.png", { type: "image/png", lastModified: 1750000000000 });
  const local = Uploads.createJob([{ file }], { ownerId, connectionId, serverUrl });
  assert.equal(local.items[0].source, "file");
  assert.equal(local.items[0].url, null);
  assert.equal(local.items[0].file, undefined);
  const restored = Uploads.recoverJob(copy(local));
  await Uploads.run(restored, { ...options, fetchImage: async () => new File([png], "different.png", { lastModified: file.lastModified }) });
  assert.equal(restored.items[0].errorCode, "file_required");
  await Uploads.run(restored, { ...options, fetchImage: async () => file });
  assert.equal(restored.status, "complete");
  assert.ok(!JSON.stringify(restored).includes("assetData"));
  console.log("Upload job, retry, cancellation, separation, and redaction tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
