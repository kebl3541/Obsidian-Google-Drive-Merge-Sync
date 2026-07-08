// An in-memory imitation of the slice of the Google Drive v3 API this plugin
// uses: token refresh, folder queries, tree listing, multipart upload, media
// download, move, and trash. Runs as a module (startMockDrive) for the
// integration test, or standalone (`node test/mock-drive.mjs 8787`) so the
// plugin can be pointed at it inside Obsidian.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

export function startMockDrive(port = 0) {
  let nextId = 1;
  const files = new Map(); // id -> {id,name,mimeType,parents,content,trashed,modifiedTime}
  const state = { failNext: 0, requests: 0 };

  const md5 = (buf) => createHash("md5").update(buf).digest("hex");
  const meta = (f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    md5Checksum: f.content ? md5(f.content) : undefined,
    size: f.content ? String(f.content.length) : undefined,
    modifiedTime: f.modifiedTime,
  });

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.requests++;
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      // Deliberate failures, for the retry test.
      if (state.failNext > 0 && !url.pathname.startsWith("/token")) {
        state.failNext--;
        return send(500, { error: "injected failure" });
      }

      if (url.pathname === "/token") {
        return send(200, {
          access_token: "mock-access-" + Date.now(),
          refresh_token: "mock-refresh",
          expires_in: 3600,
        });
      }

      if (url.pathname === "/drive/files" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const nameM = q.match(/name = '((?:[^'\\]|\\')*)'/);
        const parentM = q.match(/'([^']+)' in parents/);
        const wantFolder = q.includes("vnd.google-apps.folder");
        let list = [...files.values()].filter((f) => !f.trashed);
        if (parentM) list = list.filter((f) => f.parents.includes(parentM[1]));
        if (nameM) list = list.filter((f) => f.name === nameM[1].replace(/\\'/g, "'"));
        if (wantFolder && nameM)
          list = list.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
        return send(200, { files: list.map(meta) });
      }

      if (url.pathname === "/drive/files" && req.method === "POST") {
        const j = JSON.parse(body.toString());
        const f = {
          id: "f" + nextId++,
          name: j.name,
          mimeType: j.mimeType ?? "application/octet-stream",
          parents: j.parents ?? ["root"],
          content: null,
          trashed: false,
          modifiedTime: new Date().toISOString(),
        };
        files.set(f.id, f);
        return send(200, { id: f.id });
      }

      const fileM = url.pathname.match(/^\/drive\/files\/([^/]+)$/);
      if (fileM && req.method === "GET") {
        const f = files.get(fileM[1]);
        if (!f) return send(404, { error: "not found" });
        if (url.searchParams.get("alt") === "media") {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(f.content ?? Buffer.alloc(0));
        }
        if ((url.searchParams.get("fields") ?? "").includes("parents")) {
          return send(200, { parents: f.parents });
        }
        return send(200, meta(f));
      }

      if (fileM && req.method === "PATCH") {
        const f = files.get(fileM[1]);
        if (!f) return send(404, { error: "not found" });
        const j = body.length ? JSON.parse(body.toString()) : {};
        if (j.trashed) f.trashed = true;
        if (j.name) f.name = j.name;
        const add = url.searchParams.get("addParents");
        const remove = url.searchParams.get("removeParents");
        if (remove) f.parents = f.parents.filter((p) => !remove.split(",").includes(p));
        if (add) f.parents.push(...add.split(","));
        f.modifiedTime = new Date().toISOString();
        return send(200, meta(f));
      }

      const upM = url.pathname.match(/^\/upload\/files(?:\/([^/]+))?$/);
      if (upM && url.searchParams.get("uploadType") === "multipart") {
        const boundary = (req.headers["content-type"] ?? "").match(/boundary=(.+)$/)?.[1];
        const text = body.toString("latin1");
        const parts = text.split(`--${boundary}`).slice(1, -1);
        const cut = (p) => p.slice(p.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
        const j = JSON.parse(cut(parts[0]));
        const content = Buffer.from(cut(parts[1]), "latin1");
        let f = upM[1] ? files.get(upM[1]) : null;
        if (!f) {
          f = {
            id: "f" + nextId++,
            name: j.name,
            mimeType: "application/octet-stream",
            parents: j.parents ?? ["root"],
            trashed: false,
          };
          files.set(f.id, f);
        }
        if (j.name) f.name = j.name;
        f.content = content;
        f.modifiedTime = new Date().toISOString();
        return send(200, { id: f.id, md5Checksum: md5(content) });
      }

      send(404, { error: `no route for ${req.method} ${url.pathname}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({
        port: p,
        files,
        state,
        endpoints: {
          api: `http://127.0.0.1:${p}/drive`,
          upload: `http://127.0.0.1:${p}/upload`,
          token: `http://127.0.0.1:${p}/token`,
        },
        close: () => server.close(),
      });
    });
  });
}

// Standalone mode for live testing inside Obsidian.
if (process.argv[1] && process.argv[1].endsWith("mock-drive.mjs")) {
  const port = Number(process.argv[2] ?? 8787);
  startMockDrive(port).then((s) => {
    console.log(`mock drive listening on ${s.port}`);
  });
}
