#!/usr/bin/env node
/*
  Sync version registry V002.
  Detects changed tracked files, extracts each file's version and registers it
  through the common Worker endpoint.

  V002:
  - Adds Cloudflare Access Service Token headers for GitHub Actions.
  - Fails clearly if Cloudflare Access or another proxy returns non-JSON.
  - Keeps VERSION_REGISTRY_SECRET Bearer authentication unchanged.
*/
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const manifestPath = process.env.VERSION_REGISTRY_MANIFEST || "version-registry-manifest.json";
const apiBase = String(process.env.VERSION_REGISTRY_API_BASE || "").replace(/\/+$/, "");
const secret = process.env.VERSION_REGISTRY_SECRET || "";
const cfAccessClientId = process.env.CF_ACCESS_CLIENT_ID || "";
const cfAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET || "";
const before = process.env.GITHUB_EVENT_BEFORE || "";
const sha = process.env.GITHUB_SHA || "";
const repository = process.env.GITHUB_REPOSITORY || "oyvindhauglandweb/kvimarka92";

if (!apiBase) throw new Error("VERSION_REGISTRY_API_BASE mangler.");
if (!secret) throw new Error("VERSION_REGISTRY_SECRET mangler.");
if (!cfAccessClientId) throw new Error("CF_ACCESS_CLIENT_ID mangler.");
if (!cfAccessClientSecret) throw new Error("CF_ACCESS_CLIENT_SECRET mangler.");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

function changedFiles() {
  if (process.env.REGISTER_ALL === "1") {
    return new Set(manifest.applications.map(x => x.file));
  }

  if (!before || /^0+$/.test(before) || !sha) {
    return new Set(manifest.applications.map(x => x.file));
  }

  const out = execFileSync("git", ["diff", "--name-only", before, sha], { encoding: "utf8" });
  return new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
}

function formatVersion(n, item) {
  if (item.versionRaw === true) {
    return `${item.versionPrefix || "V"}${String(n)}`;
  }
  const width = Number(item.versionWidth || 0);
  const digits = width ? String(Number(n)).padStart(width, "0") : String(Number(n));
  return `${item.versionPrefix || "V"}${digits}`;
}

function extractVersion(text, item) {
  const regex = new RegExp(item.versionRegex, "ig");
  const matches = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    matches.push(m[1]);
    if (m[0].length === 0) regex.lastIndex++;
  }
  if (!matches.length) {
    throw new Error(`Fant ikke versjon i ${item.file} med regex ${item.versionRegex}`);
  }

  let raw;
  if (item.select === "max") {
    raw = String(Math.max(...matches.map(x => Number(x))));
  } else {
    raw = matches[0];
  }
  return formatVersion(raw, item);
}

async function register(item, version) {
  const payload = {
    application: item.application,
    component: item.component,
    version,
    fileName: item.file.split("/").pop(),
    codePlatform: item.codePlatform || "GitHub",
    githubRepository: manifest.repository || repository.split("/").pop(),
    githubPath: item.file,
    publishesTo: item.publishesTo || "GitHub Pages",
    gitCommit: sha || "",
    status: "Produksjon",
    active: true,
    comment: `Automatisk registrert fra ${repository}@${(sha || "").slice(0, 12)}`
  };

  const res = await fetch(`${apiBase}/versions/register`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "CF-Access-Client-Id": cfAccessClientId,
      "CF-Access-Client-Secret": cfAccessClientSecret,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error(
      `${item.file}: HTTP ${res.status}: ${responseText.slice(0, 1000)}`
    );
  }

  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(
      `${item.file}: versjonsregisteret returnerte ikke JSON. ` +
      `Svar: ${responseText.slice(0, 1000)}`
    );
  }

  if (typeof data !== "object" || data === null || typeof data.changed !== "boolean") {
    throw new Error(
      `${item.file}: ugyldig svar fra versjonsregisteret: ${JSON.stringify(data)}`
    );
  }

  console.log(
    `${item.application} | ${item.component} | ${item.file} -> ${version} | ` +
    `${data.changed ? "ny versjon" : "samme versjon"}`
  );
  console.log("Registry response:", JSON.stringify(data));
}

const changed = changedFiles();
const tracked = manifest.applications.filter(item => changed.has(item.file));

if (!tracked.length) {
  console.log("Ingen registrerte applikasjonsfiler ble endret.");
  process.exit(0);
}

for (const item of tracked) {
  const text = await fs.readFile(item.file, "utf8");
  const version = extractVersion(text, item);
  await register(item, version);
}
