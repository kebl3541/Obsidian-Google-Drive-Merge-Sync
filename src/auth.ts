// Loopback OAuth for a user-supplied Google "Desktop app" client: we open the
// consent page in the browser and catch the redirect on 127.0.0.1. No third
// party server ever sees the tokens; everything stays on this machine.

import { Platform } from "obsidian";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

// Minimal typings for the slice of Node's http module this file uses. The
// module is loaded at runtime via window.require, desktop only — a static
// import would break mobile loads, and Obsidian's review harness (which
// type-checks without Node type definitions) could not type it anyway.
interface LoopbackRequest {
  url?: string;
}

interface LoopbackResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

interface LoopbackServer {
  address(): { port: number } | string | null;
  close(): void;
  listen(port: number, host: string, onListening: () => void): void;
  on(event: "error", listener: (e: Error) => void): void;
}

interface HttpModule {
  createServer(
    this: void,
    handler: (req: LoopbackRequest, res: LoopbackResponse) => void
  ): LoopbackServer;
}

function loadHttp(): HttpModule {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!req) throw new Error("Loopback sign-in needs the desktop app.");
  return req("http") as HttpModule;
}

export interface AuthResult {
  code: string;
  redirectUri: string;
}

// Google's raw error codes read as gibberish at the worst moment; translate
// the ones people actually hit into the fix.
function explainAuthError(err: string | null): string {
  switch (err) {
    case "access_denied":
      return "Google blocked the sign-in (access_denied). Almost always this means the Google account you picked is not on the app's test users list. Open the setup wizard, use the link in step 4 to add that exact address as a test user, then sign in again with the same account.";
    case "invalid_client":
      return "Google does not recognize the client ID (invalid_client). Re-download the client JSON from the Google console and paste it into the setup wizard again.";
    case null:
      return "No authorization code returned.";
    default:
      return `Google sign-in failed (${err}).`;
  }
}

export async function startLoopbackAuth(
  clientId: string,
  onUrl: (url: string) => void
): Promise<AuthResult> {
  if (!Platform.isDesktopApp) {
    throw new Error(
      "Sign in on a desktop first, then move the connection to this device with the connection code in settings."
    );
  }
  const { createServer } = loadHttp();
  return new Promise((resolve, reject) => {
    let server: LoopbackServer | null = null;
    const timeout = window.setTimeout(() => {
      server?.close();
      reject(new Error("Sign-in timed out after five minutes."));
    }, 5 * 60 * 1000);

    const portOf = (srv: LoopbackServer | null): number => {
      const addr = srv?.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        code
          ? "<h2>Connected. You can close this tab and return to Obsidian.</h2>"
          : `<h2>Sign-in failed${err ? `: ${err}` : ""}. Return to Obsidian and try again.</h2>`
      );
      window.clearTimeout(timeout);
      const port = portOf(server);
      server?.close();
      if (code) {
        resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
      } else {
        reject(new Error(explainAuthError(err)));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${portOf(server)}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
      });
      onUrl(`${AUTH_URL}?${params.toString()}`);
    });

    server.on("error", (e) => {
      window.clearTimeout(timeout);
      reject(e);
    });
  });
}
