// Minimal Google Drive v3 client over Obsidian's requestUrl (no CORS pain).
// Scope drive.file: the plugin only ever sees files and folders it created,
// which is exactly the vault mirror and nothing else in anyone's Drive.

import { type RequestUrlResponse, requestUrl } from "obsidian";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Swappable for tests: a local mock server can stand in for Google.
export interface DriveEndpoints {
  api: string;
  upload: string;
  token: string;
}

const DEFAULT_ENDPOINTS: DriveEndpoints = {
  api: API,
  upload: UPLOAD,
  token: TOKEN_URL,
};

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export interface DriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
}

export class DriveClient {
  private ep: DriveEndpoints;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokens: DriveTokens,
    private onTokens: (t: DriveTokens) => void,
    endpoints?: Partial<DriveEndpoints>
  ) {
    this.ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  }

  static async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
    tokenUrl = TOKEN_URL
  ): Promise<DriveTokens> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString();
    const res = await requestUrl({
      url: tokenUrl,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
    });
    const j = res.json as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!j.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and connect again."
      );
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1000,
    };
  }

  private async token(): Promise<string> {
    if (Date.now() < this.tokens.expiresAt) return this.tokens.accessToken;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: "refresh_token",
    }).toString();
    const res = await requestUrl({
      url: this.ep.token,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body,
    });
    const j = res.json as { access_token: string; expires_in: number };
    this.tokens = {
      ...this.tokens,
      accessToken: j.access_token,
      expiresAt: Date.now() + (j.expires_in - 60) * 1000,
    };
    this.onTokens(this.tokens);
    return this.tokens.accessToken;
  }

  // Rate limits and transient server errors retry with exponential backoff
  // instead of failing the whole sync over one hiccup.
  private async call(url: string, init?: { method?: string; body?: string | ArrayBuffer; contentType?: string }) {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      const t = await this.token();
      let res: RequestUrlResponse;
      try {
        res = await requestUrl({
          url,
          method: init?.method ?? "GET",
          headers: { Authorization: `Bearer ${t}` },
          contentType: init?.contentType,
          body: init?.body,
          throw: false,
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status < 300) return res;
      if (res.status === 429 || res.status >= 500 || res.status === 403) {
        lastErr = new Error(`Drive returned ${res.status}`);
        continue;
      }
      throw new Error(`Drive returned ${res.status} for ${url.split("?")[0]}`);
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Drive request failed after retries.");
  }

  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const parent = parentId ?? "root";
    const q = encodeURIComponent(
      `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents and trashed = false`
    );
    const found = await this.call(`${this.ep.api}/files?q=${q}&fields=files(id,name)`);
    const files = (found.json as { files: DriveFile[] }).files;
    if (files.length > 0) return files[0].id;
    const created = await this.call(`${this.ep.api}/files?fields=id`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parent],
      }),
    });
    return (created.json as { id: string }).id;
  }

  // List every descendant of the root folder, returning vault-relative paths.
  async listTree(rootId: string): Promise<Map<string, DriveFile & { path: string }>> {
    const out = new Map<string, DriveFile & { path: string }>();
    const walk = async (folderId: string, prefix: string) => {
      let pageToken = "";
      do {
        const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const fields = encodeURIComponent(
          "nextPageToken, files(id,name,mimeType,md5Checksum,size,modifiedTime)"
        );
        const res = await this.call(
          `${this.ep.api}/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`
        );
        const j = res.json as { files: DriveFile[]; nextPageToken?: string };
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

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await this.call(`${this.ep.api}/files/${fileId}?alt=media`);
    return res.arrayBuffer;
  }

  // Create or update a file with multipart upload (metadata + bytes).
  async upload(
    name: string,
    parentId: string,
    content: ArrayBuffer,
    existingId?: string
  ): Promise<{ id: string; md5Checksum?: string }> {
    const boundary = "dms" + Math.random().toString(36).slice(2);
    const meta = existingId ? { name } : { name, parents: [parentId] };
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(meta) +
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const enc = new TextEncoder();
    const headB = enc.encode(head);
    const tailB = enc.encode(tail);
    const body = new Uint8Array(headB.length + content.byteLength + tailB.length);
    body.set(headB, 0);
    body.set(new Uint8Array(content), headB.length);
    body.set(tailB, headB.length + content.byteLength);

    const url = existingId
      ? `${this.ep.upload}/files/${existingId}?uploadType=multipart&fields=id,md5Checksum`
      : `${this.ep.upload}/files?uploadType=multipart&fields=id,md5Checksum`;
    const res = await this.call(url, {
      method: existingId ? "PATCH" : "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: body.buffer,
    });
    return res.json as { id: string; md5Checksum?: string };
  }

  // Rename and, if needed, move a file to a different parent folder.
  async move(fileId: string, newName: string, newParentId: string): Promise<void> {
    const cur = await this.call(`${this.ep.api}/files/${fileId}?fields=parents`);
    const parents = ((cur.json as { parents?: string[] }).parents ?? []).join(",");
    const q = parents
      ? `?addParents=${newParentId}&removeParents=${parents}`
      : `?addParents=${newParentId}`;
    await this.call(`${this.ep.api}/files/${fileId}${q}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ name: newName }),
    });
  }

  async trash(fileId: string): Promise<void> {
    await this.call(`${this.ep.api}/files/${fileId}`, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  // Ensure nested folders exist for a path like "notes/daily/2026".
  async ensurePath(rootId: string, folders: string[], cache: Map<string, string>): Promise<string> {
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
}
