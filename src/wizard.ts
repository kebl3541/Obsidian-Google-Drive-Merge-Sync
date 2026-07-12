// Guided connect flow. Google requires every app to bring its own OAuth
// client, so the one-time cost of creating one cannot be removed — but it can
// be reduced to four links and one paste. The paste box accepts the raw
// client_secret JSON Google offers for download, or both values in any shape.
import { Modal, Notice, Setting } from "obsidian";
import type DriveMergeSyncPlugin from "./main";

interface ParsedCredentials {
  clientId: string;
  clientSecret: string;
}

export function parseCredentials(text: string): ParsedCredentials | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as Record<string, { client_id?: string; client_secret?: string }>;
    const inner = obj.installed ?? obj.web ?? obj;
    if (inner.client_id && inner.client_secret) {
      return { clientId: inner.client_id, clientSecret: inner.client_secret };
    }
  } catch {
    // not JSON; fall through to pattern matching
  }
  const id = t.match(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/i)?.[0];
  const secret = t.match(/GOCSPX-[A-Za-z0-9_-]+/)?.[0];
  if (id && secret) return { clientId: id, clientSecret: secret };
  return null;
}

const STEPS: Array<{ text: string; url: string }> = [
  {
    text: "Create a project — name it anything, e.g. Obsidian Sync.",
    url: "https://console.cloud.google.com/projectcreate",
  },
  {
    text: "Enable the Google Drive API for that project (one click on Enable).",
    url: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  },
  {
    text: "Configure consent: if asked, choose External and fill only the required fields.",
    url: "https://console.cloud.google.com/auth/overview",
  },
  {
    text:
      "Add yourself as a test user: Audience → Test users → Add users → the exact Google address you will sign in with. Skipping this is what causes \"access denied / you are not allowed\".",
    url: "https://console.cloud.google.com/auth/audience",
  },
  {
    text: "Create the client: application type Desktop app, then Download JSON.",
    url: "https://console.cloud.google.com/auth/clients/create",
  },
];

export class ConnectWizard extends Modal {
  private signInButton: import("obsidian").ButtonComponent | null = null;
  private pasteStatus: HTMLElement | null = null;

  constructor(private plugin: DriveMergeSyncPlugin) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Connect Google Drive");
    contentEl.addClass("dms-wizard");

    contentEl.createEl("p", {
      text:
        "One-time setup, five minutes. Google makes every app bring its own free access key (an \"OAuth client\"); the four steps below create yours. Credentials never leave this machine.",
      cls: "dms-wizard-intro",
    });

    const ol = contentEl.createEl("ol", { cls: "dms-wizard-steps" });
    for (const step of STEPS) {
      const li = ol.createEl("li");
      li.createSpan({ text: step.text + " " });
      const a = li.createEl("a", { text: "Open ↗", href: step.url });
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    }

    contentEl.createEl("p", {
      text: "6.  Paste what you got — the whole downloaded JSON file, or the client ID and secret together in any form:",
      cls: "dms-wizard-paste-label",
    });
    const ta = contentEl.createEl("textarea", {
      cls: "dms-wizard-paste",
      attr: { rows: "4", placeholder: '{ "installed": { "client_id": "…", "client_secret": "…" } }' },
    });
    this.pasteStatus = contentEl.createDiv({ cls: "dms-wizard-status" });
    ta.addEventListener("input", () => void this.onPaste(ta.value));

    new Setting(contentEl)
      .setName("Sign in with Google")
      .setDesc("Opens your browser. Pick the same Google account you added as a test user in step 4.")
      .addButton((b) => {
        this.signInButton = b;
        b.setButtonText("Sign in with Google")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Waiting for the browser…");
            await this.plugin.connect();
            if (this.plugin.connected) this.close();
            else b.setDisabled(false).setButtonText("Sign in with Google");
          });
      });
    this.reflectCredentials(false);

    new Setting(contentEl)
      .setName("Already connected on another device?")
      .setDesc("Skip everything above: copy the connection code from that device's settings and paste it here.")
      .addText((t) => {
        t.setPlaceholder("Connection code");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void this.plugin.importConnectionCode(t.getValue()).then((ok) => {
            new Notice(ok ? "Connected from code." : "That code did not work.");
            if (ok) this.close();
          });
        });
      });
  }

  private async onPaste(text: string) {
    const creds = parseCredentials(text);
    if (!creds) {
      this.reflectCredentials(text.trim().length > 0);
      return;
    }
    this.plugin.settings.clientId = creds.clientId;
    this.plugin.settings.clientSecret = creds.clientSecret;
    await this.plugin.persist();
    this.reflectCredentials(false);
  }

  private reflectCredentials(pasteLooksWrong: boolean) {
    const has = Boolean(this.plugin.settings.clientId && this.plugin.settings.clientSecret);
    this.signInButton?.setDisabled(!has);
    if (!this.pasteStatus) return;
    this.pasteStatus.setText(
      has
        ? `✓ Credentials saved (${this.plugin.settings.clientId.slice(0, 12)}…). Now sign in below.`
        : pasteLooksWrong
          ? "That does not contain a client ID and secret yet — paste the downloaded JSON or both values."
          : ""
    );
    this.pasteStatus.toggleClass("dms-ok", has);
  }

  onClose() {
    this.contentEl.empty();
  }
}
