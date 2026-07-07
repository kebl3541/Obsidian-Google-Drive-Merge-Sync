// Loopback OAuth for a user-supplied Google "Desktop app" client: we open the
// consent page in the browser and catch the redirect on 127.0.0.1. No third
// party server ever sees the tokens; everything stays on this machine.

import { createServer } from "http";
import type { Server } from "http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface AuthResult {
  code: string;
  redirectUri: string;
}

export function startLoopbackAuth(
  clientId: string,
  onUrl: (url: string) => void
): Promise<AuthResult> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("Sign-in timed out after five minutes."));
    }, 5 * 60 * 1000);

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
      clearTimeout(timeout);
      const addr = server?.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server?.close();
      if (code) {
        resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
      } else {
        reject(new Error(err ?? "No authorization code returned."));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirectUri = `http://127.0.0.1:${port}`;
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
      clearTimeout(timeout);
      reject(e);
    });
  });
}
