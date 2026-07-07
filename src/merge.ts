// Line-based three-way merge with segment output for reviewable proposals,
// plus character-level merging inside would-be conflicts. Free of Obsidian
// imports so it can be tested standalone.
//
// `base` is the last content both sides agreed on, `mine` is the editor
// buffer (the user's typing), `theirs` is what's now on disk (the external
// collaborator's edit).

export interface MergeResult {
  merged: string;
  conflicts: number;
}

// A hunk replaces base lines [baseStart, baseEnd) with `lines`.
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

// The merged document, structured for review:
// - "plain": text that is not up for review (unchanged, or the user's own
//   local edits, or changes both sides made identically).
// - "proposal": an external change. `mine` is what the document holds without
//   it, `theirs` is the external version. `conflict` means both sides changed
//   this region differently (and character-merge could not reconcile them).
export type Segment =
  | { kind: "plain"; lines: string[] }
  | { kind: "proposal"; mine: string[]; theirs: string[]; conflict: boolean };

export interface SegmentedMerge {
  segments: Segment[];
  conflicts: number;
}

// LCS-based diff producing replace-hunks against `base`. Works on any string
// array — lines normally, single characters for the char-level pass.
export function diffLines(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        base[i] === other[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let start = -1;
  let acc: string[] = [];
  const flush = (endBase: number) => {
    if (start >= 0) {
      hunks.push({ baseStart: start, baseEnd: endBase, lines: acc });
      start = -1;
      acc = [];
    }
  };

  while (i < n && j < m) {
    if (base[i] === other[j]) {
      flush(i);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      if (start < 0) start = i;
      i++; // line deleted from base
    } else {
      if (start < 0) start = i;
      acc.push(other[j]);
      j++; // line inserted from other
    }
  }
  if (i < n || j < m) {
    if (start < 0) start = i;
    while (j < m) {
      acc.push(other[j]);
      j++;
    }
    hunks.push({ baseStart: start, baseEnd: n, lines: acc });
  } else {
    flush(i);
  }
  return hunks;
}

function overlaps(h: Hunk, s: number, e: number): boolean {
  return h.baseStart < e && h.baseEnd > s;
}

// Replay a group of disjoint, sorted hunks over base region [s, e).
function replay(base: string[], hunks: Hunk[], s: number, e: number): string[] {
  const out: string[] = [];
  let p = s;
  for (const h of hunks) {
    for (let k = p; k < h.baseStart; k++) out.push(base[k]);
    out.push(...h.lines);
    p = h.baseEnd;
  }
  for (let k = p; k < e; k++) out.push(base[k]);
  return out;
}

// Cap on the LCS DP table (cells × 4 bytes ≈ 36 MB worst case). Beyond this,
// merges degrade gracefully instead of spiking memory.
const LCS_GUARD = 9_000_000;

// Character-level three-way merge of a small region. Returns null when the
// two sides genuinely overlap at character level too (a true conflict).
export function charMerge3(
  base: string,
  mine: string,
  theirs: string
): string | null {
  if (mine === theirs) return mine;
  if (mine === base) return theirs;
  if (theirs === base) return mine;

  const b = base.split("");
  const m = mine.split("");
  const t = theirs.split("");
  if (
    (b.length + 1) * (m.length + 1) > LCS_GUARD ||
    (b.length + 1) * (t.length + 1) > LCS_GUARD
  ) {
    return null;
  }

  const A = diffLines(b, m);
  const B = diffLines(b, t);

  const out: string[] = [];
  let pos = 0;
  let ai = 0;
  let bi = 0;

  while (ai < A.length || bi < B.length) {
    const nextA = A[ai];
    const nextB = B[bi];
    const first =
      nextA && (!nextB || nextA.baseStart <= nextB.baseStart) ? nextA : nextB;

    let s = first.baseStart;
    let e = first.baseEnd;
    const ga: Hunk[] = [];
    const gb: Hunk[] = [];
    if (first === nextA) ga.push(A[ai++]);
    else gb.push(B[bi++]);

    let grew = true;
    while (grew) {
      grew = false;
      while (ai < A.length && overlaps(A[ai], s, e)) {
        const h = A[ai++];
        ga.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
      while (bi < B.length && overlaps(B[bi], s, e)) {
        const h = B[bi++];
        gb.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
    }

    // Both sides inserting at the same character position is a conflict —
    // concatenating them would interleave the two texts nonsensically.
    if (
      gb.length === 0 &&
      s === e &&
      bi < B.length &&
      B[bi].baseStart === s &&
      B[bi].baseEnd === s
    ) {
      return null;
    }
    if (
      ga.length === 0 &&
      s === e &&
      ai < A.length &&
      A[ai].baseStart === s &&
      A[ai].baseEnd === s
    ) {
      return null;
    }

    for (let k = pos; k < s; k++) out.push(b[k]);
    if (gb.length === 0) out.push(...replay(b, ga, s, e));
    else if (ga.length === 0) out.push(...replay(b, gb, s, e));
    else {
      const mineText = replay(b, ga, s, e).join("");
      const theirsText = replay(b, gb, s, e).join("");
      if (mineText === theirsText) out.push(mineText);
      else return null; // true character-level conflict
    }
    pos = Math.max(pos, e);
  }
  for (let k = pos; k < b.length; k++) out.push(b[k]);
  return out.join("");
}

// Structured merge: emits reviewable segments instead of a flat string.
export function merge3Segments(
  base: string,
  mine: string,
  theirs: string
): SegmentedMerge {
  const segments: Segment[] = [];
  const plain = (lines: string[]) => {
    if (lines.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === "plain") last.lines.push(...lines);
    else segments.push({ kind: "plain", lines: [...lines] });
  };

  if (mine === theirs) {
    plain(mine.split("\n"));
    return { segments, conflicts: 0 };
  }

  const b = base.split("\n");
  const mLines = mine.split("\n");
  const tLines = theirs.split("\n");

  const tooBig =
    (b.length + 1) * (mLines.length + 1) > LCS_GUARD ||
    (b.length + 1) * (tLines.length + 1) > LCS_GUARD;
  if (tooBig) {
    segments.push({
      kind: "proposal",
      mine: mLines,
      theirs: tLines,
      conflict: true,
    });
    return { segments, conflicts: 1 };
  }

  const A = diffLines(b, mLines); // user's hunks
  const B = diffLines(b, tLines); // external hunks

  let pos = 0;
  let ai = 0;
  let bi = 0;
  let conflicts = 0;

  while (ai < A.length || bi < B.length) {
    const nextA = A[ai];
    const nextB = B[bi];
    const first =
      nextA && (!nextB || nextA.baseStart <= nextB.baseStart) ? nextA : nextB;

    let s = first.baseStart;
    let e = first.baseEnd;
    const ga: Hunk[] = [];
    const gb: Hunk[] = [];
    if (first === nextA) ga.push(A[ai++]);
    else gb.push(B[bi++]);

    let grew = true;
    while (grew) {
      grew = false;
      while (ai < A.length && overlaps(A[ai], s, e)) {
        const h = A[ai++];
        ga.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
      while (bi < B.length && overlaps(B[bi], s, e)) {
        const h = B[bi++];
        gb.push(h);
        s = Math.min(s, h.baseStart);
        e = Math.max(e, h.baseEnd);
        grew = true;
      }
    }

    plain(b.slice(pos, s));

    if (gb.length === 0) {
      // Only the user touched this region — never up for review.
      plain(replay(b, ga, s, e));
    } else if (ga.length === 0) {
      segments.push({
        kind: "proposal",
        mine: b.slice(s, e),
        theirs: replay(b, gb, s, e),
        conflict: false,
      });
    } else {
      const mineR = replay(b, ga, s, e);
      const theirsR = replay(b, gb, s, e);
      if (mineR.join("\n") === theirsR.join("\n")) {
        plain(mineR);
      } else {
        // Both sides changed this region: try to reconcile per character.
        const cm = charMerge3(
          b.slice(s, e).join("\n"),
          mineR.join("\n"),
          theirsR.join("\n")
        );
        if (cm !== null) {
          segments.push({
            kind: "proposal",
            mine: mineR,
            theirs: cm.split("\n"),
            conflict: false,
          });
        } else {
          conflicts++;
          segments.push({
            kind: "proposal",
            mine: mineR,
            theirs: theirsR,
            conflict: true,
          });
        }
      }
    }
    pos = Math.max(pos, e);
  }
  plain(b.slice(pos));

  return { segments, conflicts };
}

// Word-level diff of two prose passages, for track-changes style rendering
// and word-accurate highlights. Tokens keep their whitespace so that
// concatenating them reproduces the exact text.
export interface WordToken {
  kind: "same" | "del" | "add";
  text: string;
}

export function diffWords(before: string, after: string): WordToken[] {
  const tokenize = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
  const a = tokenize(before);
  const b = tokenize(after);

  if ((a.length + 1) * (b.length + 1) > LCS_GUARD) {
    const out: WordToken[] = [];
    if (before) out.push({ kind: "del", text: before });
    if (after) out.push({ kind: "add", text: after });
    return out;
  }

  const hunks = diffLines(a, b); // generic over string arrays
  const out: WordToken[] = [];
  const push = (kind: WordToken["kind"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };

  let pos = 0;
  for (const h of hunks) {
    push("same", a.slice(pos, h.baseStart).join(""));
    push("del", a.slice(h.baseStart, h.baseEnd).join(""));
    push("add", h.lines.join(""));
    pos = h.baseEnd;
  }
  push("same", a.slice(pos).join(""));
  return out;
}

// Compose a document from segments and per-proposal decisions. `choices[i]`
// corresponds to the i-th proposal segment: true = take theirs, false = keep
// mine. Missing choices default to the safe side (theirs for clean proposals,
// mine for conflicts).
export function composeSegments(
  segments: Segment[],
  choices?: boolean[]
): string {
  const out: string[] = [];
  let p = 0;
  for (const seg of segments) {
    if (seg.kind === "plain") {
      out.push(...seg.lines);
    } else {
      const take = choices?.[p] ?? !seg.conflict;
      out.push(...(take ? seg.theirs : seg.mine));
      p++;
    }
  }
  return out.join("\n");
}

// Flat-string API used by the automatic mode; keeps the original semantics
// (external changes in, user wins conflicts) with char-merge improvements.
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  const { segments, conflicts } = merge3Segments(base, mine, theirs);
  return { merged: composeSegments(segments), conflicts };
}
