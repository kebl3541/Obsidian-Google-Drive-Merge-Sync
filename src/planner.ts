// The sync brain: a pure three-way diff between the last agreed state (base),
// the local vault, and the remote Drive folder. No I/O, fully testable.
//
// The rules protect data the way a careful human would:
// - changed on one side only: carry the change to the other side
// - changed on both sides: a conflict, resolved by merge (text) or kept safe
// - deleted on one side, untouched on the other: delete travels
// - deleted on one side, CHANGED on the other: the change wins, deletion loses

export interface BaseEntry {
  fileId: string;
  localMtime: number;
  remoteRev: string; // md5 checksum or version marker from Drive
}

export interface LocalEntry {
  mtime: number;
  size: number;
}

export interface RemoteEntry {
  fileId: string;
  rev: string;
  size: number;
}

export type SyncAction =
  | { kind: "uploadNew"; path: string }
  | { kind: "uploadUpdate"; path: string; fileId: string }
  | { kind: "downloadNew"; path: string; fileId: string }
  | { kind: "downloadUpdate"; path: string; fileId: string }
  | { kind: "deleteRemote"; path: string; fileId: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "conflict"; path: string; fileId: string };

export function planSync(
  base: Record<string, BaseEntry>,
  local: Record<string, LocalEntry>,
  remote: Record<string, RemoteEntry>
): SyncAction[] {
  const actions: SyncAction[] = [];
  const paths = new Set<string>([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  for (const path of [...paths].sort()) {
    const b = base[path];
    const l = local[path];
    const r = remote[path];

    const localChanged = !!(l && (!b || l.mtime > b.localMtime));
    const remoteChanged = !!(r && (!b || r.rev !== b.remoteRev));

    if (l && r) {
      if (!b) {
        // Same path appeared independently on both sides: treat as conflict
        // unless we can prove equality later at execution time.
        actions.push({ kind: "conflict", path, fileId: r.fileId });
      } else if (localChanged && remoteChanged) {
        actions.push({ kind: "conflict", path, fileId: r.fileId });
      } else if (localChanged) {
        actions.push({ kind: "uploadUpdate", path, fileId: r.fileId });
      } else if (remoteChanged) {
        actions.push({ kind: "downloadUpdate", path, fileId: r.fileId });
      }
      continue;
    }

    if (l && !r) {
      if (!b) {
        actions.push({ kind: "uploadNew", path });
      } else if (localChanged) {
        // Deleted remotely but edited locally afterwards: the edit wins.
        actions.push({ kind: "uploadNew", path });
      } else {
        actions.push({ kind: "deleteLocal", path });
      }
      continue;
    }

    if (!l && r) {
      if (!b) {
        actions.push({ kind: "downloadNew", path, fileId: r.fileId });
      } else if (remoteChanged) {
        // Deleted locally but edited remotely afterwards: the edit wins.
        actions.push({ kind: "downloadNew", path, fileId: r.fileId });
      } else {
        actions.push({ kind: "deleteRemote", path, fileId: r.fileId });
      }
      continue;
    }

    // Only in base: both sides deleted it independently. Nothing to do; the
    // executor drops the base entry.
  }

  return actions;
}
