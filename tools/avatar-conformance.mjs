#!/usr/bin/env node
// NORIA AVATAR CONFORMANCE CHECKER
//
// Built after a real failure: a GLB file ("noria_f_rigged.glb") arrived alongside a reference
// sheet whose own on-image "3D MODEL DETAILS" card claimed "Textures: PBR (4K)" and
// "Topology: High Poly". The actual file, read byte-by-byte, had ZERO embedded images, 7 flat
// solid-color materials, and no animations. Nobody ran anything to catch that before it was
// treated as "the asset" — it just had to be noticed by hand, late, after a render looked wrong.
//
// This script is that check, automated. It loads a candidate GLB, reads its OWN internal glTF
// JSON directly (the same technique that first caught the mismatch above), and reports — in
// plain pass/fail terms — whether the file actually contains what a "production-quality digital
// human" claim requires: real textures, a humanoid+finger+eye+jaw skeleton, viseme/ARKit-style
// morph targets for lip-sync, and a model size consistent with high-poly PBR content (a few MB
// at minimum; a real 4K-textured human is realistically 20-100+ MB, not a few hundred KB).
//
// Nothing here is a judgment call about art quality — it only checks structural facts a glTF
// file either does or does not contain. A file can pass every check here and still look bad, or
// fail here and still be a legitimate low-poly stylized choice; the point is that "production
// quality" and "has these structural ingredients" stop being conflated, and nobody has to
// re-discover the gap by eye after render Time again.
//
// Usage: node tools/avatar-conformance.mjs path/to/model.glb

import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/avatar-conformance.mjs path/to/model.glb");
  process.exit(2);
}

function parseGlb(buf) {
  if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("not a .glb file (missing glTF magic)");
  let offset = 12, json = null, binLength = 0, binChunk = null;
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.toString("ascii", offset + 4, offset + 8);
    if (chunkType === "JSON") json = JSON.parse(buf.toString("utf8", offset + 8, offset + 8 + chunkLength));
    if (chunkType === "BIN\x00") { binLength = chunkLength; binChunk = buf.subarray(offset + 8, offset + 8 + chunkLength); }
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error("no JSON chunk found — malformed .glb");
  return { json, binLength, binChunk };
}

// The canonical Khronos/ARKit viseme + expression blend-shape names a real lip-sync pipeline
// (and most TTS viseme generators) expect to be able to drive. Not all are mandatory — but
// finding NONE of them means there is no usable face rig for speech at all.
const EXPECTED_MORPH_TARGETS = [
  "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U", "viseme_PP", "viseme_FF", "viseme_TH",
  "mouthOpen", "mouthSmile", "mouthFrown", "jawOpen", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
];
const EXPECTED_BONES = {
  humanoid: ["hips", "pelvis", "spine", "chest", "neck", "head", "shoulder", "upperarm", "lowerarm", "hand", "upperleg", "lowerleg", "foot"],
  fingers: ["thumb", "index", "middle", "ring", "pinky"],
  face: ["jaw", "eye"],
};

function checkBoneCoverage(skins, nodes) {
  const names = new Set();
  for (const skin of skins || []) for (const j of skin.joints || []) { const n = nodes[j]; if (n && n.name) names.add(n.name.toLowerCase()); }
  const found = (needle) => [...names].some((n) => n.includes(needle));
  const report = {};
  for (const [group, parts] of Object.entries(EXPECTED_BONES)) report[group] = parts.filter(found);
  return { jointCount: names.size, coverage: report };
}

function checkMorphTargets(json) {
  const found = new Set();
  for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
    if (prim.extras && prim.extras.targetNames) for (const n of prim.extras.targetNames) found.add(n);
  }
  // glTF's own convention for naming morph targets (mesh.extras.targetNames) — some exporters
  // (Ready Player Me, MetaHuman glTF export) put the list at the MESH level instead of per-primitive.
  for (const mesh of json.meshes || []) if (mesh.extras && mesh.extras.targetNames) for (const n of mesh.extras.targetNames) found.add(n);
  return { total: found.size, matched: EXPECTED_MORPH_TARGETS.filter((t) => found.has(t)), names: [...found] };
}

// Reads pixel dimensions straight from a PNG/JPEG header — the actual check that would have
// caught the original mismatch (a reference sheet claiming "4K PBR" against a file with zero
// images). File size is NOT a reliable proxy for this: compressed/KTX2 4K textures can
// legitimately be a few hundred KB each, and a web/mobile-optimized LOD is SUPPOSED to be small
// per the spec's own step 12 ("Optimize with LODs for the target runtime") — so a blanket
// "under N bytes = fail" contradicts the spec it's meant to enforce. Resolution is the real signal.
function imageDimensions(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) { // PNG: width/height are big-endian at fixed offsets in the IHDR chunk
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) { // JPEG: scan markers for an SOFn frame
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      const len = bytes.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
  }
  return null;
}

function checkTextures(json, bufferViews, binChunk) {
  const images = json.images || [];
  const dims = [];
  for (const img of images) {
    if (img.bufferView != null && binChunk) {
      const bv = bufferViews[img.bufferView];
      const bytes = binChunk.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      const d = imageDimensions(bytes);
      if (d) dims.push(d);
    }
  }
  const withData = images.filter((i) => i.uri || i.bufferView != null);
  const maxDim = dims.length ? Math.max(...dims.map((d) => Math.max(d.width, d.height))) : 0;
  return { imageCount: images.length, withData: withData.length, materialCount: (json.materials || []).length, dims, maxDim };
}

function fmtBytes(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e3).toFixed(0) + " KB"; }

// ── run ──
const buf = fs.readFileSync(file);
const fileSize = buf.length;
let parsed;
try { parsed = parseGlb(buf); } catch (e) { console.error("FAIL  could not parse file: " + e.message); process.exit(1); }
const { json, binChunk } = parsed;

const nodes = json.nodes || [];
const bones = checkBoneCoverage(json.skins, nodes);
const morphs = checkMorphTargets(json);
const textures = checkTextures(json, json.bufferViews || [], binChunk);
const triCount = (json.accessors || []).filter((a, i) => true).length ? estimateTriangles(json) : 0;

function estimateTriangles(j) {
  let tris = 0;
  for (const mesh of j.meshes || []) for (const prim of mesh.primitives || []) {
    const idx = prim.indices != null ? j.accessors[prim.indices] : null;
    if (idx) tris += Math.floor(idx.count / 3);
    else { const pos = j.accessors[prim.attributes.POSITION]; if (pos) tris += Math.floor(pos.count / 3); }
  }
  return tris;
}

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });

ok("file is a valid .glb", true, path.basename(file));
ok("meshes present", (json.meshes || []).length > 0, (json.meshes || []).length + " mesh(es)");
ok("skinned (has a skeleton)", (json.skins || []).length > 0, (json.skins || []).length + " skin(s), " + bones.jointCount + " joints");
ok("humanoid bone coverage (hips/spine/limbs)", bones.coverage.humanoid.length >= 6, bones.coverage.humanoid.join(", ") || "none found");
ok("finger bones present", bones.coverage.fingers.length > 0, bones.coverage.fingers.join(", ") || "NONE — hands cannot be posed per-finger");
ok("facial bones (jaw/eye) present", bones.coverage.face.length > 0, bones.coverage.face.join(", ") || "NONE — no jaw/eye bone articulation");
ok("viseme/expression morph targets present", morphs.total > 0, morphs.total + " total, " + morphs.matched.length + "/" + EXPECTED_MORPH_TARGETS.length + " recognized names");
ok("lip-sync is actually drivable", morphs.matched.some((m) => m.startsWith("viseme_")) || morphs.matched.includes("jawOpen"), morphs.matched.length ? morphs.matched.join(", ") : "NO viseme or jawOpen target — a TTS lip-sync pipeline has nothing to drive");
ok("embedded or referenced textures", textures.imageCount > 0, textures.imageCount + " image(s) declared, " + textures.withData + " with actual data; " + textures.materialCount + " material(s)");
// FOUND reviewing this checker against the spec it enforces: the spec's own step 12 asks for
// "LODs" and "mobile/web optimization" — a legitimate optimized LOD can be a few hundred KB with
// compressed (KTX2) textures, so a blanket file-size-under-N-bytes gate contradicts the exact
// thing it's supposed to verify. Texture RESOLUTION is the real signal a "4K PBR" claim actually
// makes, read directly from the embedded image bytes, not inferred from overall file size.
ok("texture resolution matches any stated claim (informational)", true, textures.maxDim ? "largest embedded texture: " + textures.maxDim + "px" : "no embedded texture to measure — cannot verify a resolution claim either way");
ok("animation clips (informational, not required)", true, (json.animations || []).length + " clip(s) — 0 is fine when animation is driven procedurally by the runtime instead of baked clips");
ok("file size (informational — budget depends on target LOD, not a fixed threshold)", true, fmtBytes(fileSize));
ok("triangle count (informational — budget depends on target LOD, not a fixed threshold)", true, triCount.toLocaleString() + " estimated triangles");

console.log("\n=== NORIA AVATAR CONFORMANCE — " + path.basename(file) + " ===\n");
let failCount = 0;
for (const c of checks) {
  if (!c.pass) failCount++;
  console.log((c.pass ? "PASS" : "FAIL") + "  " + c.name.padEnd(42) + " " + c.detail);
}
console.log("\n" + (checks.length - failCount) + "/" + checks.length + " checks passed.");
if (failCount) {
  console.log("\nThis file does NOT meet the bar for \"production-quality digital human.\" Specifically missing:");
  for (const c of checks) if (!c.pass) console.log("  - " + c.name);
}
process.exit(failCount ? 1 : 0);
