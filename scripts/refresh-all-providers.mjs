// refresh-all-providers.mjs — re-capture every web-provider session from the
// live Chrome (port 9222) into auth-profiles.json. Called by the desktop
// script Refresh-All-Providers.ps1. Idempotent: only overwrites when it gets
// a valid fresh value.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/VectorHQ/token-free-gateway-dev/");
const WebSocket = require("ws");

const CDP = "http://127.0.0.1:9222";
const PROFILE = "C:/Users/Nedal/.token-free-gateway/auth-profiles.json";

async function getTabs() {
  const res = await fetch(`${CDP}/json`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result || msg.error);
        pending.delete(msg.id);
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res) => {
            const mid = ++id;
            pending.set(mid, res);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
      }),
    );
    ws.on("error", reject);
  });
}

async function capture(tab, matcher, fn) {
  if (!tab) return null;
  const c = await connect(tab.webSocketDebuggerUrl);
  try {
    return await fn(c);
  } finally {
    c.ws.close();
  }
}

const tabs = await getTabs();
const profiles = JSON.parse(readFileSync(PROFILE, "utf8"));
let updated = [];

// ---- deepseek: bearer (localStorage) + cookies + hif-leim ----
const dsTab = tabs.find((t) => /chat\.deepseek\.com/.test(t.url || ""));
if (dsTab) {
  const data = await capture(dsTab, null, async (c) => {
    const r = await c.send("Runtime.evaluate", {
      expression: `(() => {
        const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
        return JSON.stringify({ bearer: get('ds_bearer') || get('token') || get('access_token') });
      })()`,
      returnByValue: true,
    });
    const cookies = await c.send("Network.getCookies", { urls: ["https://chat.deepseek.com/"] });
    const cookie = (cookies?.cookies || []).map((x) => `${x.name}=${x.value}`).join("; ");
    return { bearer: JSON.parse(r?.result?.value || "{}").bearer, cookie };
  });
  if (data?.cookie) {
    profiles.profiles["deepseek-web"] = {
      ...profiles.profiles["deepseek-web"],
      credentials: { ...profiles.profiles["deepseek-web"]?.credentials, cookie: data.cookie },
      updatedAt: new Date().toISOString(),
    };
    updated.push("deepseek-web (cookies)");
  }
}

// ---- kimi: access_token + refresh_token (localStorage) ----
const kimiTab = tabs.find((t) => /kimi\.com/.test(t.url || ""));
if (kimiTab) {
  const data = await capture(kimiTab, null, async (c) => {
    const r = await c.send("Runtime.evaluate", {
      expression: `(() => {
        const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
        return JSON.stringify({ at: get('access_token'), rt: get('refresh_token') });
      })()`,
      returnByValue: true,
    });
    return JSON.parse(r?.result?.value || "{}");
  });
  if (data?.at) {
    profiles.profiles["kimi-web"] = {
      ...profiles.profiles["kimi-web"],
      credentials: {
        ...profiles.profiles["kimi-web"]?.credentials,
        accessToken: data.at,
        refreshToken: data.rt || profiles.profiles["kimi-web"]?.credentials?.refreshToken || "",
      },
      updatedAt: new Date().toISOString(),
    };
    updated.push("kimi-web (tokens)");
  }
}

// ---- glm: cookies (chatglm_token) ----
const glmTab = tabs.find((t) => /chatglm\.cn/.test(t.url || ""));
if (glmTab) {
  const cookie = await capture(glmTab, null, async (c) => {
    const r = await c.send("Network.getCookies", { urls: ["https://chatglm.cn/"] });
    return (r?.cookies || []).map((x) => `${x.name}=${x.value}`).join("; ");
  });
  if (cookie) {
    profiles.profiles["glm-web"] = {
      ...profiles.profiles["glm-web"],
      credentials: { ...profiles.profiles["glm-web"]?.credentials, cookie },
      updatedAt: new Date().toISOString(),
    };
    updated.push("glm-web (cookies)");
  }
}

// ---- chatgpt: session cookies ----
const gptTab = tabs.find((t) => /chatgpt\.com/.test(t.url || ""));
if (gptTab) {
  const cookie = await capture(gptTab, null, async (c) => {
    const r = await c.send("Network.getCookies", { urls: ["https://chatgpt.com/"] });
    return (r?.cookies || []).map((x) => `${x.name}=${x.value}`).join("; ");
  });
  if (cookie) {
    profiles.profiles["chatgpt-web"] = {
      ...profiles.profiles["chatgpt-web"],
      credentials: { ...profiles.profiles["chatgpt-web"]?.credentials, cookie },
      updatedAt: new Date().toISOString(),
    };
    updated.push("chatgpt-web (cookies)");
  }
}

// ---- qwen: cookies ----
const qwenTab = tabs.find((t) => /qwen\.ai/.test(t.url || ""));
if (qwenTab) {
  const cookie = await capture(qwenTab, null, async (c) => {
    const r = await c.send("Network.getCookies", { urls: ["https://chat.qwen.ai/"] });
    return (r?.cookies || []).map((x) => `${x.name}=${x.value}`).join("; ");
  });
  if (cookie) {
    profiles.profiles["qwen-web"] = {
      ...profiles.profiles["qwen-web"],
      credentials: { ...profiles.profiles["qwen-web"]?.credentials, cookie },
      updatedAt: new Date().toISOString(),
    };
    updated.push("qwen-web (cookies)");
  }
}

writeFileSync(PROFILE, JSON.stringify(profiles, null, 2));
console.log("Refreshed:", updated.length ? updated.join(", ") : "nothing (no tabs found / no fresh data)");
console.log("Note: kimi auto-refreshes its short-lived access token at request time via refresh_token.");
