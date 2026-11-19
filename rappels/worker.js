/**
 * Service de rappels pour « Mes tâches » — Worker Cloudflare
 *
 * Toutes les minutes, il lit taches.json dans ton repo GitHub privé et envoie
 * une notification sur ton iPhone pour chaque tâche dont le rappel arrive à échéance.
 *
 * À configurer dans Cloudflare (voir le guide) :
 *   - secret   GITHUB_TOKEN  : jeton GitHub en lecture seule sur taches-donnees
 *   - liaison  KV            : un espace de stockage KV nommé KV
 *   - déclencheur cron       : * * * * *
 * Optionnel (valeurs par défaut ci-dessous) : GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH
 */

const DEFAULTS = { owner: "jbgernet", repo: "taches-donnees", path: "taches.json" };
const APP_URL = "https://jbgernet.github.io/taches/";
const WINDOW_MS = 6 * 3600 * 1000; // rattrape un rappel manqué jusqu'à 6 h plus tard

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/public-key") {
        const keys = await getVapidKeys(env);
        return json({ key: keys.publicKey });
      }
      if (url.pathname === "/test" && request.method === "POST") {
        const { subscription } = await request.json();
        if (!subscription || !subscription.endpoint || !subscription.keys) return json({ ok: false, error: "abonnement manquant" }, 400);
        const r = await sendPush(env, subscription, { title: "Notifications activées ✓", body: "Tes rappels de tâches arriveront ici.", tag: "test" });
        return json({ ok: r.ok, status: r.status });
      }
      if (url.pathname === "/status") {
        const data = await loadData(env);
        const now = Date.now();
        const tasks = (data.tasks || []).filter(t => t.remind && !t.done);
        return json({
          ok: true,
          abonnements: activeSubs(data).length,
          rappels_a_venir: tasks.filter(t => t.remind > now).length,
          prochain_rappel: tasks.filter(t => t.remind > now).map(t => new Date(t.remind).toISOString()).sort()[0] || null,
        });
      }
      return json({ ok: true, service: "rappels Mes tâches" });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};

/* ---------- Envoi des rappels ---------- */
async function runReminders(env) {
  const data = await loadData(env);
  const now = Date.now();
  const deleted = data.deleted || {};
  const subs = activeSubs(data);
  if (!subs.length) return;
  const projects = new Map((data.projects || []).map(p => [p.id, p]));
  const due = (data.tasks || []).filter(t =>
    t.remind && !t.done && !deleted[t.id] && t.remind <= now && t.remind > now - WINDOW_MS);

  for (const t of due) {
    const key = `sent:${t.id}:${t.remind}`;
    if (await env.KV.get(key)) continue;
    const p = t.projectId ? projects.get(t.projectId) : null;
    const payload = { title: t.title, body: p ? `Rappel · ${p.name}` : "Rappel", tag: t.id, url: APP_URL };
    await Promise.all(subs.map(s => sendPush(env, s, payload).catch(() => null)));
    await env.KV.put(key, "1", { expirationTtl: 3 * 86400 });
  }
}

function activeSubs(data) {
  const deleted = data.deleted || {};
  return (data.subs || []).filter(s => s.endpoint && s.keys && !deleted[s.id]);
}

// Lit une variable sans tenir compte des majuscules (GITHUB_TOKEN, github_token…)
function envGet(env, name) {
  for (const k of Object.keys(env)) if (k.toLowerCase() === name.toLowerCase() && typeof env[k] === "string" && env[k].trim()) return env[k].trim();
  return null;
}

async function loadData(env) {
  const token = envGet(env, "GITHUB_TOKEN");
  if (!token) throw new Error("secret GITHUB_TOKEN manquant (variables vues : " + Object.keys(env).join(", ") + ")");
  const owner = envGet(env, "GITHUB_OWNER") || DEFAULTS.owner, repo = envGet(env, "GITHUB_REPO") || DEFAULTS.repo, path = envGet(env, "GITHUB_PATH") || DEFAULTS.path;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "taches-rappels",
    },
  });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error("GitHub " + r.status);
  return await r.json();
}

/* ---------- Clés VAPID (créées une fois, gardées dans KV) ---------- */
async function getVapidKeys(env) {
  const stored = await env.KV.get("vapid", "json");
  if (stored) return stored;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const keys = { publicKey, privateJwk };
  await env.KV.put("vapid", JSON.stringify(keys));
  return keys;
}

async function vapidAuth(env, endpoint) {
  const keys = await getVapidKeys(env);
  const aud = new URL(endpoint).origin;
  const enc = s => b64url(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL });
  const priv = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

/* ---------- Web Push (RFC 8291, aes128gcm) ---------- */
async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(payload)));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "3600",
      "Urgency": "high",
    },
    body,
  });
}

async function encryptPayload(sub, plaintext) {
  const uaPublic = unb64url(sub.keys.p256dh);
  const authSecret = unb64url(sub.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/* ---------- Utilitaires ---------- */
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function cors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } }));
}
