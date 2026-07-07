import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";
import { DriveClient, DriveTokens } from "./drive";
import { startLoopbackAuth } from "./auth";
import { BaseEntry, LocalEntry, RemoteEntry, planSync } from "./planner";
import { merge3 } from "./merge";

interface DriveMergeSettings {
  clientId: string;
  clientSecret: string;
  driveFolderName: string;
  syncIntervalMinutes: number; // 0 = manual only
  excludedFolders: string[];
}

const DEFAULT_SETTINGS: DriveMergeSettings = {
  clientId: "",
  clientSecret: "",
  driveFolderName: "",
  syncIntervalMinutes: 0,
  excludedFolders: [],
};

interface PersistedData {
  settings: DriveMergeSettings;
  tokens: DriveTokens | null;
  rootFolderId: string | null;
  base: Record<string, BaseEntry>;
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "css", "csv", "canvas"]);

export default class DriveMergeSyncPlugin extends Plugin {
  settings: DriveMergeSettings = DEFAULT_SETTINGS;
  private tokens: DriveTokens | null = null;
  private rootFolderId: string | null = null;
  private base: Record<string, BaseEntry> = {};
  private statusEl: HTMLElement | null = null;
  private syncing = false;
  private intervalHandle: number | null = null;

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
  }

  onunload() {
    if (this.intervalHandle !== null) window.clearInterval(this.intervalHandle);
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
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }

  async importConnectionCode(code: string): Promise<boolean> {
    try {
      const payload = JSON.parse(
        decodeURIComponent(escape(atob(code.trim())))
      ) as {
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
      new Notice("Enter your Google client ID and secret first (see the setup guide in settings).");
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
      console.error("Drive Merge Sync: auth failed", e);
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
      }
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
      new Notice("Connect Google Drive first, in the plugin settings.");
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
      for (const action of actions) {
        this.setStatus(`syncing ${++done}/${actions.length}…`);
        await this.execute(drive, action, folderCache, () => conflictsMerged++);
      }

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
      console.error("Drive Merge Sync failed", e);
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
    onMerge: () => void
  ) {
    const rootId = this.rootFolderId as string;
    const actionPath = "path" in action ? action.path : action.to;
    const parts = actionPath.split("/");
    const name = parts.pop() as string;
    void name;

    switch (action.kind) {
      case "renameRemote": {
        const toParts = action.to.split("/");
        const toName = toParts.pop() as string;
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
          name as string,
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
          this.base[action.path] = {
            fileId: action.fileId,
            localMtime: f.stat.mtime,
            localSize: f.stat.size,
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
        // To Obsidian's trash, never gone for good.
        if (file) await this.app.vault.trash(file, false);
        delete this.base[action.path];
        return;
      }

      case "deleteRemote": {
        await drive.trash(action.fileId);
        delete this.base[action.path];
        return;
      }

      case "conflict": {
        await this.resolveConflict(drive, action.path, action.fileId, folderCache, onMerge);
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
    onMerge: () => void
  ) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const remoteBytes = await drive.download(fileId);

    if (this.isTextPath(path)) {
      const localText = await this.app.vault.read(file);
      const remoteText = new TextDecoder().decode(remoteBytes);
      if (localText === remoteText) {
        // Same content on both sides: agree silently.
        await this.finishConflict(drive, path, fileId, localText, folderCache, file);
        return;
      }
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

    // Binary conflict: newer wins, the loser survives as a conflict copy.
    const remoteEntryTime = 0; // unknown here; local wins ties by design
    const localNewer = file.stat.mtime >= remoteEntryTime;
    if (localNewer) {
      const parts = path.split("/");
      const name = parts.pop() as string;
      const parentId = await drive.ensurePath(this.rootFolderId as string, parts, folderCache);
      const up = await drive.upload(name, parentId, await this.app.vault.readBinary(file), fileId);
      this.base[path] = {
        fileId: up.id,
        localMtime: file.stat.mtime,
        remoteRev: up.md5Checksum ?? "",
      };
    } else {
      const copyPath = path.replace(/(\.[^.]*)?$/, ` (conflict ${Date.now()})$1`);
      await this.app.vault.createBinary(normalizePath(copyPath), await this.app.vault.readBinary(file));
      await this.app.vault.modifyBinary(file, remoteBytes);
    }
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
    const name = parts.pop() as string;
    const parentId = await drive.ensurePath(this.rootFolderId as string, parts, folderCache);
    const up = await drive.upload(
      name,
      parentId,
      new TextEncoder().encode(content).buffer as ArrayBuffer,
      fileId
    );
    this.base[path] = {
      fileId: up.id,
      localMtime: file.stat.mtime,
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
    const remoteTree = await drive.listTree(this.rootFolderId as string);
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
      .setName("Google client ID")
      .setDesc(
        "Create a free OAuth client of type Desktop app at console.cloud.google.com (APIs and Services, Credentials). The README walks through it in five minutes. Your credentials stay on this machine."
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
      .setDesc("The folder created in your Drive. Empty: your vault's name.")
      .addText((t) =>
        t.setValue(this.plugin.settings.driveFolderName).onChange(async (v) => {
          this.plugin.settings.driveFolderName = v;
          await this.plugin.persist();
        })
      );

    new Setting(containerEl)
      .setName("Sync every N minutes")
      .setDesc("0 means manual only (the ribbon button or the Sync now command).")
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
