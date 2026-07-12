import {
  FileView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import { DriveClient, DriveEndpoints, DriveTokens } from "./drive";
import { startLoopbackAuth } from "./auth";
import { ConnectWizard } from "./wizard";
import { BaseEntry, LocalEntry, RemoteEntry, planSync } from "./planner";
import { merge3 } from "./merge";

interface DriveMergeSettings {
  clientId: string;
  clientSecret: string;
  driveFolderName: string;
  syncIntervalMinutes: number; // 0 = manual only
  syncOnStartup: boolean;
  excludedFolders: string[];
}

const DEFAULT_SETTINGS: DriveMergeSettings = {
  clientId: "",
  clientSecret: "",
  driveFolderName: "",
  syncIntervalMinutes: 0,
  syncOnStartup: false,
  excludedFolders: [],
};

// How many uploads/downloads run at once. Drive tolerates this happily and
// first syncs get several times faster than one-at-a-time.
const TRANSFER_CONCURRENCY = 4;

interface PersistedData {
  settings: DriveMergeSettings;
  tokens: DriveTokens | null;
  rootFolderId: string | null;
  base: Record<string, BaseEntry>;
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "css", "csv", "canvas"]);

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

/** UTF-8 safe base64, replacing the deprecated escape/unescape idiom. */
function b64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64DecodeUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export default class DriveMergeSyncPlugin extends Plugin {
  settings: DriveMergeSettings = DEFAULT_SETTINGS;
  private tokens: DriveTokens | null = null;
  private rootFolderId: string | null = null;
  private base: Record<string, BaseEntry> = {};
  private statusEl: HTMLElement | null = null;
  private syncing = false;
  private intervalHandle: number | null = null;
  private seenViews = new WeakSet<object>();
  private headerButtons = new Set<HTMLElement>();
  // Test hook: point the client at a mock Drive server instead of Google.
  debugEndpoints: Partial<DriveEndpoints> | null = null;

  async onload() {
    await this.loadPersisted();

    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.tokens ? "ready" : "not connected");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () =>
      void this.syncNow()
    );
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "dry-run",
      name: "Preview what a sync would do (dry run)",
      callback: () => void this.syncNow(true),
    });

    this.addSettingTab(new DriveMergeSettingTab(this));
    this.applyInterval();

    // One cloud button in every note pane header: sync when connected,
    // open the setup wizard when not.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.ensureHeaderButtons()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.ensureHeaderButtons()));
    this.app.workspace.onLayoutReady(() => this.ensureHeaderButtons());

    if (this.settings.syncOnStartup && this.tokens) {
      this.app.workspace.onLayoutReady(() =>
        window.setTimeout(() => void this.syncNow(), 3000)
      );
    }
  }

  onunload() {
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
    for (const el of this.headerButtons) el.detach();
    this.headerButtons.clear();
  }

  get connected(): boolean {
    return this.tokens !== null;
  }

  private ensureHeaderButtons() {
    for (const type of ["markdown", "pdf"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (!(view instanceof FileView) || this.seenViews.has(view)) continue;
        this.seenViews.add(view);
        const el = view.addAction("cloud", "Sync with Google Drive", () => {
          if (this.connected) void this.syncNow();
          else new ConnectWizard(this).open();
        });
        this.headerButtons.add(el);
      }
    }
  }

  applyInterval() {
    if (this.intervalHandle !== null) {
      window.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const minutes = this.settings.syncIntervalMinutes;
    if (minutes > 0) {
      this.intervalHandle = window.setInterval(
        () => void this.syncNow(),
        minutes * 60 * 1000
      );
      this.registerInterval(this.intervalHandle);
    }
  }

  private async loadPersisted() {
    const raw = (await this.loadData()) as Partial<PersistedData> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);
    this.tokens = raw?.tokens ?? null;
    this.rootFolderId = raw?.rootFolderId ?? null;
    this.base = raw?.base ?? {};
  }

  async persist() {
    const data: PersistedData = {
      settings: this.settings,
      tokens: this.tokens,
      rootFolderId: this.rootFolderId,
      base: this.base,
    };
    await this.saveData(data);
  }

  private setStatus(text: string) {
    this.statusEl?.setText(`Drive: ${text}`);
  }

  // ---- Connection -----------------------------------------------------------

  exportConnectionCode(): string | null {
    if (!this.tokens) return null;
    const payload = {
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      tokens: this.tokens,
      rootFolderId: this.rootFolderId,
      driveFolderName: this.settings.driveFolderName,
    };
    return b64EncodeUtf8(JSON.stringify(payload));
  }

  async importConnectionCode(code: string): Promise<boolean> {
    try {
      const payload = JSON.parse(b64DecodeUtf8(code.trim())) as {
        clientId: string;
        clientSecret: string;
        tokens: DriveTokens;
        rootFolderId: string | null;
        driveFolderName: string;
      };
      if (!payload.tokens?.refreshToken) return false;
      this.settings.clientId = payload.clientId;
      this.settings.clientSecret = payload.clientSecret;
      this.settings.driveFolderName = payload.driveFolderName ?? "";
      this.tokens = payload.tokens;
      this.rootFolderId = payload.rootFolderId;
      await this.persist();
      this.setStatus("connected");
      return true;
    } catch {
      return false;
    }
  }

  async connect() {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      new ConnectWizard(this).open();
      return;
    }
    try {
      const result = await startLoopbackAuth(this.settings.clientId, (url) => {
        window.open(url);
        new Notice("Complete the Google sign-in in your browser.");
      });
      this.tokens = await DriveClient.exchangeCode(
        this.settings.clientId,
        this.settings.clientSecret,
        result.code,
        result.redirectUri
      );
      await this.persist();
      this.setStatus("connected");
      new Notice("Google Drive connected.");
    } catch (e) {
      console.error("Google Drive Merge Sync: auth failed", e);
      new Notice(`Google sign-in failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  disconnect() {
    this.tokens = null;
    this.rootFolderId = null;
    void this.persist();
    this.setStatus("not connected");
  }

  private client(): DriveClient | null {
    if (!this.tokens) return null;
    return new DriveClient(
      this.settings.clientId,
      this.settings.clientSecret,
      this.tokens,
      (t) => {
        this.tokens = t;
        void this.persist();
      },
      this.debugEndpoints ?? undefined
    );
  }

  // ---- Sync -----------------------------------------------------------------

  private excluded(path: string): boolean {
    for (const folder of this.settings.excludedFolders) {
      const clean = folder.trim().replace(/\/$/, "");
      if (clean && (path === clean || path.startsWith(clean + "/"))) return true;
    }
    return false;
  }

  private isTextPath(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return TEXT_EXTENSIONS.has(ext);
  }

  async syncNow(dryRun = false) {
    if (this.syncing) {
      new Notice("A sync is already running.");
      return;
    }
    const drive = this.client();
    if (!drive) {
      new ConnectWizard(this).open();
      return;
    }
    this.syncing = true;
    this.setStatus(dryRun ? "previewing…" : "syncing…");
    try {
      // Root folder on Drive: named after the vault unless configured.
      const folderName =
        this.settings.driveFolderName.trim() || this.app.vault.getName();
      if (!this.rootFolderId) {
        this.rootFolderId = await drive.ensureFolder(folderName);
        await this.persist();
      }

      // Gather the three states.
      const localFiles = this.app.vault.getFiles().filter((f) => !this.excluded(f.path));
      const local: Record<string, LocalEntry> = {};
      for (const f of localFiles) {
        local[f.path] = { mtime: f.stat.mtime, size: f.stat.size };
      }
      const remoteTree = await drive.listTree(this.rootFolderId);
      const remote: Record<string, RemoteEntry> = {};
      for (const [path, f] of remoteTree) {
        if (this.excluded(path)) continue;
        remote[path] = {
          fileId: f.id,
          rev: f.md5Checksum ?? f.modifiedTime ?? "",
          size: Number(f.size ?? 0),
          mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
        };
      }

      const actions = planSync(this.base, local, remote);
      if (dryRun) {
        const summary = actions.length
          ? actions
              .map((a) =>
                "path" in a ? `${a.kind}: ${a.path}` : `${a.kind}: ${a.from} → ${a.to}`
              )
              .slice(0, 30)
              .join("\n")
          : "Nothing to do; everything is in sync.";
        new Notice(`Dry run (${actions.length} actions):\n${summary}`, 10000);
        this.setStatus("ready");
        return;
      }

      const folderCache = new Map<string, string>();
      let done = 0;
      let conflictsMerged = 0;

      // Renames, deletes, and conflicts run one at a time (they are rare and
      // some touch merge state). Plain transfers run in a small pool.
      const transfers = actions.filter(
        (a) => a.kind.startsWith("upload") || a.kind.startsWith("download")
      );
      const serial = actions.filter((a) => !transfers.includes(a));

      // Folder creation must not race, so all needed remote folders are
      // ensured up front, one by one, before the parallel phase.
      const rootId = this.rootFolderId;
      if (!rootId) throw new Error("Drive folder is not initialized yet.");
      for (const a of transfers) {
        if (a.kind === "uploadNew" || a.kind === "uploadUpdate") {
          const parts = a.path.split("/");
          parts.pop();
          if (parts.length) await drive.ensurePath(rootId, parts, folderCache);
        }
      }

      for (const action of serial) {
        this.setStatus(`syncing ${++done}/${actions.length}…`);
        await this.execute(drive, action, folderCache, remote, () => conflictsMerged++);
      }

      const queue = [...transfers];
      const worker = async () => {
        for (;;) {
          const action = queue.shift();
          if (!action) return;
          this.setStatus(`syncing ${++done}/${actions.length}…`);
          await this.execute(drive, action, folderCache, remote, () => conflictsMerged++);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(TRANSFER_CONCURRENCY, queue.length) }, worker)
      );

      // Refresh the base index from the now agreed state.
      await this.rebuildBase(drive);
      await this.persist();
      this.setStatus(
        `synced ${new Date().toLocaleTimeString()}${conflictsMerged ? ` · ${conflictsMerged} conflict(s) merged` : ""}`
      );
      if (actions.length > 0) {
        new Notice(
          `Drive sync: ${actions.length} change(s)${conflictsMerged ? `, ${conflictsMerged} conflict(s) resolved by merge` : ""}.`
        );
      }
    } catch (e) {
      console.error("Google Drive Merge Sync failed", e);
      this.setStatus("sync failed");
      new Notice(`Drive sync failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.syncing = false;
    }
  }

  private baseDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/base`;
  }

  private baseSlug(path: string): string {
    return path.replace(/[/\\]/g, "__");
  }

  private async readBaseCopy(path: string): Promise<string | null> {
    const p = `${this.baseDir()}/${this.baseSlug(path)}`;
    if (!(await this.app.vault.adapter.exists(p))) return null;
    return this.app.vault.adapter.read(p);
  }

  private async moveBaseCopy(from: string, to: string) {
    const dir = this.baseDir();
    const src = `${dir}/${this.baseSlug(from)}`;
    if (await this.app.vault.adapter.exists(src)) {
      const content = await this.app.vault.adapter.read(src);
      await this.app.vault.adapter.write(`${dir}/${this.baseSlug(to)}`, content);
      await this.app.vault.adapter.remove(src);
    }
  }

  private async writeBaseCopy(path: string, content: string) {
    const dir = this.baseDir();
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(`${dir}/${this.baseSlug(path)}`, content);
  }

  private async execute(
    drive: DriveClient,
    action: ReturnType<typeof planSync>[number],
    folderCache: Map<string, string>,
    remote: Record<string, RemoteEntry>,
    onMerge: () => void
  ) {
    const rootId = this.rootFolderId;
    if (!rootId) throw new Error("Drive folder is not initialized yet.");
    const actionPath = "path" in action ? action.path : action.to;
    const parts = actionPath.split("/");
    const name = parts.pop();
    if (!name) return;

    switch (action.kind) {
      case "renameRemote": {
        const toParts = action.to.split("/");
        const toName = toParts.pop();
        if (!toName) return;
        const parentId = await drive.ensurePath(rootId, toParts, folderCache);
        await drive.move(action.fileId, toName, parentId);
        const entry = this.base[action.from];
        delete this.base[action.from];
        const f = this.app.vault.getAbstractFileByPath(action.to);
        this.base[action.to] = {
          fileId: action.fileId,
          localMtime: f instanceof TFile ? f.stat.mtime : entry?.localMtime ?? 0,
          localSize: f instanceof TFile ? f.stat.size : entry?.localSize,
          remoteRev: entry?.remoteRev ?? "",
        };
        await this.moveBaseCopy(action.from, action.to);
        return;
      }

      case "renameLocal": {
        const from = this.app.vault.getAbstractFileByPath(action.from);
        if (from instanceof TFile) {
          const toParts = action.to.split("/");
          toParts.pop();
          await this.ensureLocalFolders(toParts);
          // fileManager keeps links pointing at the renamed note.
          await this.app.fileManager.renameFile(from, normalizePath(action.to));
        }
        const entry = this.base[action.from];
        delete this.base[action.from];
        const f = this.app.vault.getAbstractFileByPath(action.to);
        this.base[action.to] = {
          fileId: action.fileId,
          localMtime: f instanceof TFile ? f.stat.mtime : 0,
          localSize: f instanceof TFile ? f.stat.size : undefined,
          remoteRev: entry?.remoteRev ?? "",
        };
        await this.moveBaseCopy(action.from, action.to);
        return;
      }

      case "uploadNew":
      case "uploadUpdate": {
        const file = this.app.vault.getAbstractFileByPath(action.path);
        if (!(file instanceof TFile)) return;
        const content = await this.app.vault.readBinary(file);
        const parentId = await drive.ensurePath(rootId, parts, folderCache);
        const uploaded = await drive.upload(
          name,
          parentId,
          content,
          action.kind === "uploadUpdate" ? action.fileId : undefined
        );
        this.base[action.path] = {
          fileId: uploaded.id,
          localMtime: file.stat.mtime,
          localSize: file.stat.size,
          remoteRev: uploaded.md5Checksum ?? "",
        };
        if (this.isTextPath(action.path)) {
          await this.writeBaseCopy(action.path, await this.app.vault.read(file));
        }
        return;
      }

      case "downloadNew":
      case "downloadUpdate": {
        const bytes = await drive.download(action.fileId);
        await this.ensureLocalFolders(parts);
        const existing = this.app.vault.getAbstractFileByPath(action.path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, bytes);
        } else {
          await this.app.vault.createBinary(normalizePath(action.path), bytes);
        }
        const f = this.app.vault.getAbstractFileByPath(action.path);
        if (f instanceof TFile) {
          const st = await this.freshStat(f);
          this.base[action.path] = {
            fileId: action.fileId,
            localMtime: st.mtime,
            localSize: st.size,
            remoteRev: "", // filled by rebuildBase
          };
          if (this.isTextPath(action.path)) {
            await this.writeBaseCopy(action.path, await this.app.vault.read(f));
          }
        }
        return;
      }

      case "deleteLocal": {
        const file = this.app.vault.getAbstractFileByPath(action.path);
        // Trashed per the user's "deleted files" preference, never silently gone.
        if (file) await this.app.fileManager.trashFile(file);
        delete this.base[action.path];
        return;
      }

      case "deleteRemote": {
        await drive.trash(action.fileId);
        delete this.base[action.path];
        return;
      }

      case "conflict": {
        await this.resolveConflict(
          drive,
          action.path,
          action.fileId,
          folderCache,
          remote[action.path]?.mtime ?? 0,
          onMerge
        );
        return;
      }
    }
  }

  // The superpower: text conflicts resolve by word-level three-way merge.
  private async resolveConflict(
    drive: DriveClient,
    path: string,
    fileId: string,
    folderCache: Map<string, string>,
    remoteMtime: number,
    onMerge: () => void
  ) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const remoteBytes = await drive.download(fileId);
    const localBytes = await this.app.vault.readBinary(file);

    // Identical bytes on both sides: adopt silently, no upload. This is what
    // makes connecting a second device that already holds the vault painless.
    if (bytesEqual(localBytes, remoteBytes)) {
      this.base[path] = {
        fileId,
        localMtime: file.stat.mtime,
        localSize: file.stat.size,
        remoteRev: "", // filled by rebuildBase
      };
      if (this.isTextPath(path)) {
        await this.writeBaseCopy(path, await this.app.vault.read(file));
      }
      return;
    }

    if (this.isTextPath(path)) {
      const localText = await this.app.vault.read(file);
      const remoteText = new TextDecoder().decode(remoteBytes);
      const baseText = (await this.readBaseCopy(path)) ?? "";
      const { merged, conflicts } = merge3(baseText, localText, remoteText);
      await this.app.vault.modify(file, merged);
      await this.finishConflict(drive, path, fileId, merged, folderCache, file);
      onMerge();
      if (conflicts > 0) {
        new Notice(
          `${path}: both sides changed the same words; your version was kept there.`
        );
      }
      return;
    }

    // Binary conflict: newer side wins, the loser survives as a conflict copy.
    if (file.stat.mtime >= remoteMtime) {
      const parts = path.split("/");
      const name = parts.pop();
      const rootId = this.rootFolderId;
      if (!name || !rootId) return;
      const parentId = await drive.ensurePath(rootId, parts, folderCache);
      const up = await drive.upload(name, parentId, localBytes, fileId);
      this.base[path] = {
        fileId: up.id,
        localMtime: file.stat.mtime,
        localSize: file.stat.size,
        remoteRev: up.md5Checksum ?? "",
      };
    } else {
      const copyPath = path.replace(/(\.[^.]*)?$/, ` (conflict ${Date.now()})$1`);
      await this.app.vault.createBinary(normalizePath(copyPath), localBytes);
      await this.app.vault.modifyBinary(file, remoteBytes);
      const st = await this.freshStat(file);
      this.base[path] = {
        fileId,
        localMtime: st.mtime,
        localSize: st.size,
        remoteRev: "", // filled by rebuildBase
      };
    }
  }

  // TFile.stat refreshes asynchronously after a write, so mtime read from it
  // right after vault.modify can be stale; the disk is the truth. A stale
  // mtime in base breaks exact-match rename detection on the next sync.
  private async freshStat(file: TFile): Promise<{ mtime: number; size: number }> {
    const st = await this.app.vault.adapter.stat(file.path);
    return st ? { mtime: st.mtime, size: st.size } : file.stat;
  }

  private async finishConflict(
    drive: DriveClient,
    path: string,
    fileId: string,
    content: string,
    folderCache: Map<string, string>,
    file: TFile
  ) {
    const parts = path.split("/");
    const name = parts.pop();
    const rootId = this.rootFolderId;
    if (!name || !rootId) return;
    const parentId = await drive.ensurePath(rootId, parts, folderCache);
    const bytes = new TextEncoder().encode(content);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const up = await drive.upload(name, parentId, body, fileId);
    const st = await this.freshStat(file);
    this.base[path] = {
      fileId: up.id,
      localMtime: st.mtime,
      localSize: st.size,
      remoteRev: up.md5Checksum ?? "",
    };
    await this.writeBaseCopy(path, content);
  }

  private async ensureLocalFolders(parts: string[]) {
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        await this.app.vault.createFolder(acc).catch(() => undefined);
      }
    }
  }

  // After executing, re-list the remote so base holds true revisions.
  private async rebuildBase(drive: DriveClient) {
    const rootId = this.rootFolderId;
    if (!rootId) return;
    const remoteTree = await drive.listTree(rootId);
    for (const [path, f] of remoteTree) {
      const entry = this.base[path];
      if (entry) {
        entry.fileId = f.id;
        entry.remoteRev = f.md5Checksum ?? f.modifiedTime ?? "";
      }
    }
    for (const path of Object.keys(this.base)) {
      if (!remoteTree.has(path)) delete this.base[path];
    }
  }
}

// ---- Settings ---------------------------------------------------------------

class DriveMergeSettingTab extends PluginSettingTab {
  plugin: DriveMergeSyncPlugin;

  constructor(plugin: DriveMergeSyncPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Set up")
      .setDesc("The wizard walks through the one-time Google setup: four links, one paste, one sign-in.")
      .addButton((b) =>
        b.setButtonText("Open setup wizard").setCta().onClick(() => new ConnectWizard(this.plugin).open())
      );

    new Setting(containerEl)
      .setName("Google client ID")
      .setDesc(
        "Filled automatically by the wizard; edit only if you manage credentials by hand. They stay on this machine."
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.clientId).onChange(async (v) => {
          this.plugin.settings.clientId = v.trim();
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Google client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
          this.plugin.settings.clientSecret = v.trim();
          await this.plugin.persist();
        });
      });

    new Setting(containerEl)
      .setName("Connect")
      .setDesc("Opens Google sign-in in your browser. The plugin only ever sees the folder it creates.")
      .addButton((b) =>
        b.setButtonText("Connect Google Drive").setCta().onClick(() => void this.plugin.connect())
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(() => {
          this.plugin.disconnect();
          new Notice("Disconnected.");
        })
      );

    new Setting(containerEl)
      .setName("Connection code")
      .setDesc(
        "Move this connection to another device (phone or tablet): copy the code here, paste it in the same setting there. Treat the code like a password."
      )
      .addButton((b) =>
        b.setButtonText("Copy code").onClick(async () => {
          const code = this.plugin.exportConnectionCode();
          if (!code) {
            new Notice("Connect Google Drive first.");
            return;
          }
          await navigator.clipboard.writeText(code);
          new Notice("Connection code copied. Paste it on your other device.");
        })
      )
      .addText((t) => {
        t.setPlaceholder("Paste a code from another device");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.plugin.importConnectionCode(t.getValue()).then((ok) => {
              new Notice(ok ? "Connected from code." : "That code did not work.");
              if (ok) t.setValue("");
            });
          }
        });
      });

    new Setting(containerEl)
      .setName("Drive folder name")
      .setDesc("Name of the sync folder in your drive; leave empty to use the vault's name.")
      .addText((t) =>
        t.setValue(this.plugin.settings.driveFolderName).onChange(async (v) => {
          this.plugin.settings.driveFolderName = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("Set to 0 for manual sync only (ribbon button or the sync command).")
      .addSlider((s) =>
        s
          .setLimits(0, 120, 5)
          .setValue(this.plugin.settings.syncIntervalMinutes)
          .onChange(async (v) => {
            this.plugin.settings.syncIntervalMinutes = v;
            await this.plugin.persist();
            this.plugin.applyInterval();
          })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a sync a few seconds after the app opens.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One per line. These never leave your vault.")
      .addTextArea((ta) =>
        ta
          .setValue(this.plugin.settings.excludedFolders.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.excludedFolders = v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.persist();
          })
      );
  }
}
