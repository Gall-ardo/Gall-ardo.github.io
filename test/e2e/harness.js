/**
 * Shared harness for the browser end-to-end checks.
 *
 * Fails closed in three ways:
 *   1. The Firestore Emulator must answer on loopback before anything starts.
 *   2. The browser project ID is rewritten to a `demo-` project, which makes the
 *      Firebase tooling refuse every non-emulated service.
 *   3. Every request to a host other than loopback or the SDK CDN is aborted, so a
 *      regression that bypasses connectFirestoreEmulator cannot silently reach
 *      production Firestore -- it fails the run instead.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
export const PROJECT = "demo-abk";
const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
const DOCUMENTS = `http://${EMULATOR_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(EMULATOR_HOST)) {
  throw new Error(`Refusing to run against non-loopback emulator host ${EMULATOR_HOST}.`);
}
if (!PROJECT.startsWith("demo-")) throw new Error("Refusing to run against a non-demo project ID.");

/** Hosts the browser may reach: the local site, the local emulator, the SDK CDN. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "www.gstatic.com"]);

export async function requireEmulator() {
  let response;
  try {
    response = await fetch(`http://${EMULATOR_HOST}/`);
  } catch (error) {
    throw new Error(
      `Firestore Emulator is not reachable at ${EMULATOR_HOST}. Start it with:\n` +
        `  firebase emulators:start --only firestore --project ${PROJECT}\n` +
        `(cause: ${error.message})`,
    );
  }
  if (!response.ok) throw new Error(`Firestore Emulator answered ${response.status} at ${EMULATOR_HOST}.`);
}

/** Drops every document in the project, so each run starts from an empty database. */
export async function resetEmulator() {
  const response = await fetch(
    `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Could not clear the emulator: HTTP ${response.status}`);
}

export async function readCollection(name) {
  const response = await fetch(`${DOCUMENTS}/${name}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not read ${name}: HTTP ${response.status}`);
  const body = await response.json();
  return body.documents ?? [];
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** Serves the built Astro output, which is what the browser checks load. */
export async function startSite() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    let file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const type = TYPES[extname(file)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/absolute-ball-knowledge/?emulator=1`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Collects everything the run has to be able to report on: console errors, page
 * errors, failed requests, and every Firestore write the browser actually sent.
 */
export function instrument(page) {
  const record = { consoleErrors: [], pageErrors: [], failedRequests: [], blocked: [], writes: [] };

  page.on("console", (message) => {
    if (message.type() === "error") record.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => record.pageErrors.push(`${error.name}: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // Aborts this harness performed itself are reported separately.
    if (!record.blocked.includes(request.url())) {
      record.failedRequests.push(`${request.method()} ${request.url()} -> ${failure}`);
    }
  });
  page.on("request", (request) => {
    const body = request.postData();
    if (!body || !request.url().includes(EMULATOR_HOST)) return;
    // Commits carry the document the rules judge; listens and target changes do not.
    const isCommit = /Commit|"writes"|%22writes%22/.test(request.url() + body);
    record.writes.push({ url: request.url(), body, isCommit });
  });
  page.on("response", async (response) => {
    if (!response.url().includes(EMULATOR_HOST)) return;
    if (response.status() >= 400) record.failedRequests.push(`${response.request().method()} ${response.url()} -> HTTP ${response.status()}`);
  });
  return record;
}

/**
 * One handler, because Playwright consults route handlers in reverse registration
 * order: a separate catch-all would shadow the config rewrite rather than compose
 * with it, and the browser would quietly keep the production project ID.
 */
export async function guardRoutes(context, record) {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;

    if (!ALLOWED_HOSTS.has(host)) {
      record.blocked.push(url);
      return route.abort("blockedbyclient");
    }

    // Point the browser at a demo project. Emulator rules enforcement is identical
    // across project IDs, and a `demo-` project can never reach production.
    if (url.includes("/js/firebase-config.js")) {
      const response = await route.fetch();
      const body = (await response.text()).replace(/projectId:\s*"[^"]*"/, `projectId: "${PROJECT}"`);
      return route.fulfill({ response, body });
    }

    return route.continue();
  });
}
