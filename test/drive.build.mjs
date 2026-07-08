// test/obsidian-shim.mjs
async function requestUrl(opts) {
  const { url, method = "GET", headers = {}, contentType, body } = opts;
  const doThrow = opts.throw !== false;
  const h = { ...headers };
  if (contentType)
    h["Content-Type"] = contentType;
  const res = await fetch(url, {
    method,
    headers: h,
    body: body instanceof ArrayBuffer ? Buffer.from(body) : body
  });
  const arrayBuffer = await res.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  if (doThrow && res.status >= 400) {
    throw new Error(`Request failed, status ${res.status}`);
  }
  return { status: res.status, arrayBuffer, text, json };
}
if (typeof globalThis.window === "undefined")
  globalThis.window = globalThis;

// src/drive.ts
var API = "https://www.googleapis.com/drive/v3";
var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var DEFAULT_ENDPOINTS = {
  api: API,
  upload: UPLOAD,
  token: TOKEN_URL
};
var sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
var DriveClient = class {
  constructor(clientId, clientSecret, tokens, onTokens, endpoints) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = tokens;
    this.onTokens = onTokens;
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  }
  static async exchangeCode(clientId, clientSecret, code, redirectUri, tokenUrl = TOKEN_URL) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString();
    const res = await requestUrl({
      url: tokenUrl,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body
    });
    const j = res.json;
    if (!j.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and connect again."
      );
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1e3
    };
  }
  async token() {
    if (Date.now() < this.tokens.expiresAt)
      return this.tokens.accessToken;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: "refresh_token"
    }).toString();
    const res = await requestUrl({
      url: this.ep.token,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body
    });
    const j = res.json;
    this.tokens = {
      ...this.tokens,
      accessToken: j.access_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1e3
    };
    this.onTokens(this.tokens);
    return this.tokens.accessToken;
  }
  // Rate limits and transient server errors retry with exponential backoff
  // instead of failing the whole sync over one hiccup.
  async call(url, init) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0)
        await sleep(500 * 2 ** attempt);
      const t = await this.token();
      let res;
      try {
        res = await requestUrl({
          url,
          method: init?.method ?? "GET",
          headers: { Authorization: `Bearer ${t}` },
          contentType: init?.contentType,
          body: init?.body,
          throw: false
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status < 300)
        return res;
      if (res.status === 429 || res.status >= 500 || res.status === 403) {
        lastErr = new Error(`Drive returned ${res.status}`);
        continue;
      }
      throw new Error(`Drive returned ${res.status} for ${url.split("?")[0]}`);
    }
    throw lastErr instanceof Error ? lastErr : new Error("Drive request failed after retries.");
  }
  async ensureFolder(name, parentId) {
    const parent = parentId ?? "root";
    const q = encodeURIComponent(
      `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`
    );
    const found = await this.call(`${this.ep.api}/files?q=${q}&fields=files(id,name)`);
    const files = found.json.files;
    if (files.length > 0)
      return files[0].id;
    const created = await this.call(`${this.ep.api}/files?fields=id`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parent]
      })
    });
    return created.json.id;
  }
  // List every descendant of the root folder, returning vault-relative paths.
  async listTree(rootId) {
    const out = /* @__PURE__ */ new Map();
    const walk = async (folderId, prefix) => {
      let pageToken = "";
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const fields = encodeURIComponent(
          "nextPageToken, files(id,name,mimeType,md5Checksum,size,modifiedTime)"
        );
        const res = await this.call(
          `${this.ep.api}/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`
        );
        const j = res.json;
        for (const f of j.files) {
          const path = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.mimeType === "application/vnd.google-apps.folder") {
            await walk(f.id, path);
          } else {
            out.set(path, { ...f, path });
          }
        }
        pageToken = j.nextPageToken ?? "";
      } while (pageToken);
    };
    await walk(rootId, "");
    return out;
  }
  async download(fileId) {
    const res = await this.call(`${this.ep.api}/files/${fileId}?alt=media`);
    return res.arrayBuffer;
  }
  // Create or update a file with multipart upload (metadata + bytes).
  async upload(name, parentId, content, existingId) {
    const boundary = "dms" + Math.random().toString(36).slice(2);
    const meta = existingId ? { name } : { name, parents: [parentId] };
    const head = `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
` + JSON.stringify(meta) + `\r
--${boundary}\r
Content-Type: application/octet-stream\r
\r
`;
    const tail = `\r
--${boundary}--`;
    const enc = new TextEncoder();
    const headB = enc.encode(head);
    const tailB = enc.encode(tail);
    const body = new Uint8Array(headB.length + content.byteLength + tailB.length);
    body.set(headB, 0);
    body.set(new Uint8Array(content), headB.length);
    body.set(tailB, headB.length + content.byteLength);
    const url = existingId ? `${this.ep.upload}/files/${existingId}?uploadType=multipart&fields=id,md5Checksum` : `${this.ep.upload}/files?uploadType=multipart&fields=id,md5Checksum`;
    const res = await this.call(url, {
      method: existingId ? "PATCH" : "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer
    });
    return res.json;
  }
  // Rename and, if needed, move a file to a different parent folder.
  async move(fileId, newName, newParentId) {
    const cur = await this.call(`${this.ep.api}/files/${fileId}?fields=parents`);
    const parents = (cur.json.parents ?? []).join(",");
    const q = parents ? `?addParents=${newParentId}&removeParents=${parents}` : `?addParents=${newParentId}`;
    await this.call(`${this.ep.api}/files/${fileId}${q}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ name: newName })
    });
  }
  async trash(fileId) {
    await this.call(`${this.ep.api}/files/${fileId}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true })
    });
  }
  // Ensure nested folders exist for a path like "notes/daily/2026".
  async ensurePath(rootId, folders, cache) {
    let parent = rootId;
    let key = "";
    for (const part of folders) {
      key = key ? `${key}/${part}` : part;
      const hit = cache.get(key);
      if (hit) {
        parent = hit;
        continue;
      }
      parent = await this.ensureFolder(part, parent);
      cache.set(key, parent);
    }
    return parent;
  }
};
export {
  DriveClient
};
