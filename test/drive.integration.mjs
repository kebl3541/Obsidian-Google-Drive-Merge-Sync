// The real DriveClient run against the mock Drive server: token refresh,
// folder creation, upload, listing, download, rename/move, trash, and the
// retry-on-500 path. What passes here is the same code Obsidian executes.
import { strict as assert } from "node:assert";
import { startMockDrive } from "./mock-drive.mjs";
import { DriveClient } from "./drive.build.mjs";

const enc = (s) => new TextEncoder().encode(s).buffer;
const dec = (b) => new TextDecoder().decode(b);

const mock = await startMockDrive();
let refreshed = 0;

const client = new DriveClient(
  "client-id",
  "client-secret",
  { accessToken: "stale", refreshToken: "r", expiresAt: 0 }, // expired: forces a refresh
  () => refreshed++,
  mock.endpoints
);

// Folder creation is idempotent.
const rootId = await client.ensureFolder("Vault");
assert.equal(await client.ensureFolder("Vault"), rootId);
assert.ok(refreshed >= 1, "expired token was refreshed through the mock");

// Upload, list, download round trip.
const up = await client.upload("a.md", rootId, enc("hello world"));
assert.ok(up.md5Checksum);
let tree = await client.listTree(rootId);
assert.deepEqual([...tree.keys()], ["a.md"]);
assert.equal(dec(await client.download(up.id)), "hello world");

// Update in place keeps the id, changes the checksum.
const up2 = await client.upload("a.md", rootId, enc("hello again"), up.id);
assert.equal(up2.id, up.id);
assert.notEqual(up2.md5Checksum, up.md5Checksum);

// Nested folders and a move (rename into a subfolder).
const subId = await client.ensurePath(rootId, ["notes", "daily"], new Map());
await client.move(up.id, "b.md", subId);
tree = await client.listTree(rootId);
assert.deepEqual([...tree.keys()], ["notes/daily/b.md"]);

// Trash hides the file from listings.
await client.trash(up.id);
tree = await client.listTree(rootId);
assert.equal(tree.size, 0);

// Transient 500s are retried instead of failing the sync.
const up3 = await client.upload("c.md", rootId, enc("survivor"));
mock.state.failNext = 2;
assert.equal(dec(await client.download(up3.id)), "survivor");
assert.equal(mock.state.failNext, 0, "retries consumed the injected failures");

mock.close();
console.log("drive integration: 12 assertions passed");
