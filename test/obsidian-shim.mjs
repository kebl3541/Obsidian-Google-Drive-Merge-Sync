// Minimal stand-in for the obsidian module so drive.ts can run under node in
// the integration test. Mirrors requestUrl's contract: resolved properties,
// throw-on-4xx by default, throw:false passes status through.
export async function requestUrl(opts) {
  const { url, method = "GET", headers = {}, contentType, body } = opts;
  const doThrow = opts.throw !== false;
  const h = { ...headers };
  if (contentType) h["Content-Type"] = contentType;
  const res = await fetch(url, {
    method,
    headers: h,
    body: body instanceof ArrayBuffer ? Buffer.from(body) : body,
  });
  const arrayBuffer = await res.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON bodies are fine
  }
  if (doThrow && res.status >= 400) {
    throw new Error(`Request failed, status ${res.status}`);
  }
  return { status: res.status, arrayBuffer, text, json };
}

// drive.ts uses window.setTimeout for popout-window compatibility inside
// Obsidian; under node the test provides window as an alias of globalThis.
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
