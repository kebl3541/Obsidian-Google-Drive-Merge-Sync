// Sync planner test suite: the rules that keep vaults safe, proven headlessly.
import { strict as assert } from "node:assert";
import { planSync } from "./planner.build.mjs";

let count = 0;
const t = (name, fn) => {
  count++;
  try {
    fn();
  } catch (e) {
    console.error("FAIL", name);
    throw e;
  }
};

const kinds = (a) => a.map((x) => `${x.kind}:${x.path}`);

t("fresh local file uploads", () => {
  assert.deepEqual(
    kinds(planSync({}, { "a.md": { mtime: 10, size: 1 } }, {})),
    ["uploadNew:a.md"]
  );
});

t("fresh remote file downloads", () => {
  assert.deepEqual(
    kinds(planSync({}, {}, { "a.md": { fileId: "x", rev: "r1", size: 1 } })),
    ["downloadNew:a.md"]
  );
});

t("unchanged file does nothing", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    planSync(base, { "a.md": { mtime: 10, size: 1 } }, { "a.md": { fileId: "x", rev: "r1", size: 1 } }),
    []
  );
});

t("local edit uploads", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, { "a.md": { mtime: 20, size: 1 } }, { "a.md": { fileId: "x", rev: "r1", size: 1 } })),
    ["uploadUpdate:a.md"]
  );
});

t("remote edit downloads", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, { "a.md": { mtime: 10, size: 1 } }, { "a.md": { fileId: "x", rev: "r2", size: 1 } })),
    ["downloadUpdate:a.md"]
  );
});

t("both edited is a conflict", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, { "a.md": { mtime: 20, size: 1 } }, { "a.md": { fileId: "x", rev: "r2", size: 1 } })),
    ["conflict:a.md"]
  );
});

t("local delete travels to remote", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, {}, { "a.md": { fileId: "x", rev: "r1", size: 1 } })),
    ["deleteRemote:a.md"]
  );
});

t("remote delete travels to local", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, { "a.md": { mtime: 10, size: 1 } }, {})),
    ["deleteLocal:a.md"]
  );
});

t("edit beats remote delete", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, { "a.md": { mtime: 20, size: 1 } }, {})),
    ["uploadNew:a.md"]
  );
});

t("remote edit beats local delete", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(
    kinds(planSync(base, {}, { "a.md": { fileId: "x", rev: "r2", size: 1 } })),
    ["downloadNew:a.md"]
  );
});

t("both deleted settles silently", () => {
  const base = { "a.md": { fileId: "x", localMtime: 10, remoteRev: "r1" } };
  assert.deepEqual(planSync(base, {}, {}), []);
});

t("same path born on both sides is a conflict", () => {
  assert.deepEqual(
    kinds(planSync({}, { "a.md": { mtime: 5, size: 1 } }, { "a.md": { fileId: "x", rev: "r1", size: 1 } })),
    ["conflict:a.md"]
  );
});

t("mixed tree plans deterministically", () => {
  const base = {
    "keep.md": { fileId: "k", localMtime: 1, remoteRev: "r" },
    "gone-local.md": { fileId: "g", localMtime: 1, remoteRev: "r" },
  };
  const local = {
    "keep.md": { mtime: 1, size: 1 },
    "new-here.md": { mtime: 9, size: 1 },
  };
  const remote = {
    "keep.md": { fileId: "k", rev: "r", size: 1 },
    "gone-local.md": { fileId: "g", rev: "r", size: 1 },
    "new-there.md": { fileId: "n", rev: "r9", size: 1 },
  };
  assert.deepEqual(kinds(planSync(base, local, remote)), [
    "deleteRemote:gone-local.md",
    "uploadNew:new-here.md",
    "downloadNew:new-there.md",
  ]);
});

console.log(`planner: ${count} tests passed`);

t("local rename becomes renameRemote", () => {
  const base = { "old.md": { fileId: "x", localMtime: 10, localSize: 7, remoteRev: "r1" } };
  const local = { "new.md": { mtime: 10, size: 7 } };
  const remote = { "old.md": { fileId: "x", rev: "r1", size: 7 } };
  assert.deepEqual(planSync(base, local, remote), [
    { kind: "renameRemote", from: "old.md", to: "new.md", fileId: "x" },
  ]);
});

t("remote rename becomes renameLocal", () => {
  const base = { "old.md": { fileId: "x", localMtime: 10, localSize: 7, remoteRev: "r1" } };
  const local = { "old.md": { mtime: 10, size: 7 } };
  const remote = { "new.md": { fileId: "x", rev: "r1", size: 7 } };
  assert.deepEqual(planSync(base, local, remote), [
    { kind: "renameLocal", from: "old.md", to: "new.md", fileId: "x" },
  ]);
});

t("ambiguous rename falls back to delete plus create", () => {
  const base = {
    "a.md": { fileId: "x", localMtime: 10, localSize: 7, remoteRev: "r1" },
    "b.md": { fileId: "y", localMtime: 10, localSize: 7, remoteRev: "r2" },
  };
  const local = {
    "c.md": { mtime: 10, size: 7 },
    "d.md": { mtime: 10, size: 7 },
  };
  const remote = {
    "a.md": { fileId: "x", rev: "r1", size: 7 },
    "b.md": { fileId: "y", rev: "r2", size: 7 },
  };
  const kindsOnly = planSync(base, local, remote).map((a) => a.kind).sort();
  assert.deepEqual(kindsOnly, ["deleteRemote", "deleteRemote", "uploadNew", "uploadNew"]);
});

console.log(`planner extended: ${count} total`);
