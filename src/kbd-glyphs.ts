const SYMBOLS: Record<string, string> = {
  '⌘': 'cmd',
  '⇧': 'shift',
  '⌥': 'opt',
  '⌃': 'ctrl',
  '↵': 'enter',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
  '⌫': 'backspace',
};

function normalize(kbd: HTMLElement): void {
  const text = kbd.textContent?.trim() ?? '';
  const glyph = SYMBOLS[text];
  if (glyph == null) {
    if (kbd.dataset.glyph != null) delete kbd.dataset.glyph;
    return;
  }
  if (kbd.dataset.glyph === glyph) return;
  kbd.dataset.glyph = glyph;
  kbd.setAttribute('aria-label', text);
}

/** `<kbd>` markup that already carries its glyph, so a freshly rendered key never shows a raw-text frame before the observer catches it. */
export function kbdHtml(text: string): string {
  const glyph = SYMBOLS[text];
  return glyph == null ? `<kbd>${text}</kbd>` : `<kbd data-glyph="${glyph}" aria-label="${text}">${text}</kbd>`;
}

export function normalizeKbdGlyphs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('kbd').forEach(normalize);
}

export function watchKbdGlyphs(): void {
  normalizeKbdGlyphs();
  let frame = 0;
  new MutationObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => normalizeKbdGlyphs());
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
