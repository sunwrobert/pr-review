import type { ParsedFile } from './diffs';

export type FindHit =
  | { kind: 'text'; range: Range }
  | { kind: 'diff'; fileId: string; fileName: string; lineNumber: number; side: 'additions' | 'deletions'; text: string };

interface DiffLine {
  lineNumber: number;
  side: 'additions' | 'deletions';
  text: string;
}

/** Every rendered line of a parsed diff with its real file line number, additions preferred for context lines. */
export function diffLines(file: ParsedFile): DiffLine[] {
  const { diff } = file;
  const lines: DiffLine[] = [];
  for (const hunk of diff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let offset = 0; offset < block.lines; offset += 1) {
          const index = block.additionLineIndex + offset;
          lines.push({ lineNumber: hunk.additionStart + (index - hunk.additionLineIndex), side: 'additions', text: diff.additionLines[index] ?? '' });
        }
        continue;
      }
      for (let offset = 0; offset < block.deletions; offset += 1) {
        const index = block.deletionLineIndex + offset;
        lines.push({ lineNumber: hunk.deletionStart + (index - hunk.deletionLineIndex), side: 'deletions', text: diff.deletionLines[index] ?? '' });
      }
      for (let offset = 0; offset < block.additions; offset += 1) {
        const index = block.additionLineIndex + offset;
        lines.push({ lineNumber: hunk.additionStart + (index - hunk.additionLineIndex), side: 'additions', text: diff.additionLines[index] ?? '' });
      }
    }
  }
  return lines;
}

export function findInDiff(files: readonly ParsedFile[], query: string): FindHit[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  return files.flatMap((file) =>
    diffLines(file)
      .filter((line) => line.text.toLowerCase().includes(needle))
      .map((line): FindHit => ({ kind: 'diff', fileId: file.id, fileName: file.diff.name, lineNumber: line.lineNumber, side: line.side, text: line.text.trim() })),
  );
}

/** Text ranges for every case-insensitive match inside `root`, skipping hidden subtrees. */
export function findInDom(root: Element, query: string): FindHit[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const hits: FindHit[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[hidden], script, style, .skeleton') != null ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const haystack = (node.textContent ?? '').toLowerCase();
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      hits.push({ kind: 'text', range });
    }
  }
  return hits;
}
