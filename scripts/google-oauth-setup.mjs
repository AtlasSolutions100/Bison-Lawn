/**
 * One-time: mint a Gmail refresh token for this deployment.
 *
 * Run it once per business account. It opens Google's consent screen, catches
 * the redirect on a loopback port, and prints the refresh token to paste into
 * .env as GOOGLE_REFRESH_TOKEN. The token does not expire unless it is revoked
 * or the Google Cloud OAuth app is left in "Testing" publishing status (those
 * expire after 7 days — publish the app before relying on it).
 *
 * Prerequisites in Google Cloud Console, on the project for this deployment:
 *   1. Enable the Gmail API.
 *   2. Configure the OAuth consent screen; add the business Gmail address as a
 *      user, and publish the app when you are done testing.
 *   3. Create an OAuth client of type "Desktop app". Copy its id and secret.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-oauth-setup.mjs
 * or put them in .env first and just run:
 *   node scripts/google-oauth-setup.mjs
 */
import http from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the environment) first.");
  process.exit(1);
}

// gmail.send only. The app never reads mail, and a narrower scope is a smaller
// thing to explain on the consent screen and a smaller thing to lose.
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

function openBrowser(url) {
  // NOT `cmd /c start`: cmd.exe treats & as a command separator, so it hands the
  // browser only the part of the URL before the first &. That silently drops
  // response_type and Google answers "Required parameter is missing:
  // response_type" - an error that looks like a bad request rather than a
  // mangled URL. rundll32 takes the URL as one argument, unparsed.
  const command =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Printing the URL below is the fallback.
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  const finish = (message) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">${message}</body>`);
  };

  if (error || !code) {
    finish("Authorization failed. Check the terminal.");
    console.error(`\nAuthorization failed: ${error ?? "no code returned"}`);
    server.close();
    process.exit(1);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.refresh_token) {
    finish("Token exchange failed. Check the terminal.");
    console.error("\nToken exchange failed:", JSON.stringify(data, null, 2));
    if (response.ok && !data.refresh_token) {
      console.error(
        "\nGoogle returns a refresh token only on the first consent for an account.\n" +
          "Revoke this app at https://myaccount.google.com/permissions and run this again.",
      );
    }
    server.close();
    process.exit(1);
  }

  finish("Authorized. You can close this tab and return to the terminal.");
  console.log("\nAdd this line to .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
  server.close();
});

let port;
let redirectUri;
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  // Both are required to get a refresh token back rather than only an access token.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\nSign in as the account mail should be SENT FROM (it becomes the visible sender):\n");
  console.log(authUrl.toString() + "\n");
  console.log(`Waiting for the redirect on ${redirectUri} ...`);
  openBrowser(authUrl.toString());
});
