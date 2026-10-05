import { glideScrollBy, glideScrollTo, prefersReducedMotion } from './motion';
import { CodeView, parsePatchFiles, type CodeViewDiffItem, type FileDiffMetadata } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';

export type DiffStyle = 'split' | 'unified';

export interface ParsedFile {
  id: string;
  diff: FileDiffMetadata;
  additions: number;
  deletions: number;
}

interface DiffViewCallbacks {
  onToggle(id: string, isCollapsed: boolean): void;
}

type ViewOptions = NonNullable<ConstructorParameters<typeof CodeView<undefined, undefined>>[0]>;

const WORKER_COUNT = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
const LARGE_FILE_LINES = 1500;
const GENERATED_FILE = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$|\.snap$|\.min\.(js|css)$/;

const HEADER_CSS = `
:host { border: 1px solid var(--diffs-card-border, #23252a); border-radius: 8px; }
[data-diffs-header], [data-separator], [data-column-number] { -webkit-user-select: none; user-select: none; }
[data-diffs-header=default] { border-radius: 8px 8px 0 0; cursor: pointer; user-select: none; padding-inline: 12px; }
[data-diffs-header=default]:hover { background: color-mix(in srgb, var(--diffs-bg) 92%, var(--diffs-mixer)); }
`;

const FLUSH_CSS = `
:host { border-width: 0 0 1px; border-radius: 0; }
[data-diffs-header=default] { border-radius: 0; }
`;

const workerPool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new DiffWorker(), poolSize: WORKER_COUNT },
  highlighterOptions: { theme: { dark: 'pierre-dark', light: 'pierre-light' }, lineDiffType: 'word-alt' },
});

function countChanges(diff: FileDiffMetadata): { additions: number; deletions: number } {
  return diff.hunks.reduce(
    (total, hunk) => ({ additions: total.additions + hunk.additionLines, deletions: total.deletions + hunk.deletionLines }),
    { additions: 0, deletions: 0 },
  );
}

export function parseDiff(cacheKey: string, patch: string): ParsedFile[] {
  return parsePatchFiles(patch, cacheKey)
    .flatMap((parsed) => parsed.files)
    .map((diff, index) => ({ id: `${index}:${diff.name}`, diff, ...countChanges(diff) }));
}

function shouldStartCollapsed(file: ParsedFile): boolean {
  return GENERATED_FILE.test(file.diff.name) || file.diff.unifiedLineCount > LARGE_FILE_LINES;
}

function chevron(id: string, isCollapsed: boolean): HTMLElement {
  const icon = document.createElement('span');
  icon.dataset.fileId = id;
  icon.textContent = '›';
  icon.style.cssText = `display:inline-flex;width:14px;justify-content:center;color:#8a8f98;font-size:15px;transition:transform .12s;transform:rotate(${isCollapsed ? 0 : 90}deg)`;
  return icon;
}

export class DiffView {
  private readonly view: CodeView<undefined, undefined>;
  private readonly root: HTMLElement;
  private readonly callbacks: DiffViewCallbacks;
  private header: HTMLElement | undefined;
  private isFlush = false;
  private themeType: 'dark' | 'light' = 'dark';
  private themeNames: Record<'dark' | 'light', string> = { dark: 'pierre-dark', light: 'pierre-light' };
  private diffStyle: DiffStyle;
  private collapsed = new Set<string>();
  private ids: string[] = [];

  constructor(root: HTMLElement, diffStyle: DiffStyle, callbacks: DiffViewCallbacks) {
    this.root = root;
    this.diffStyle = diffStyle;
    this.callbacks = callbacks;
    this.view = new CodeView<undefined, undefined>(this.options(), workerPool);
    this.view.setup(root);
    root.addEventListener('click', this.handleHeaderClick);
  }

  setHeader(header: HTMLElement | undefined): void {
    this.header = header;
    this.view.setOptions(this.options());
  }

  show(files: readonly ParsedFile[]): void {
    this.ids = files.map((file) => file.id);
    this.collapsed = new Set(files.filter(shouldStartCollapsed).map((file) => file.id));
    this.view.setItems(files.map((file): CodeViewDiffItem => ({ id: file.id, type: 'diff', fileDiff: file.diff, collapsed: this.collapsed.has(file.id) })));
    this.root.scrollTop = 0;
  }

  isCollapsed(id: string): boolean {
    return this.collapsed.has(id);
  }

  collapsedCount(): number {
    return this.collapsed.size;
  }

  setTheme(themeType: 'dark' | 'light', themeName: string): void {
    if (this.themeType === themeType && this.themeNames[themeType] === themeName) return;
    this.themeType = themeType;
    this.themeNames = { ...this.themeNames, [themeType]: themeName };
    void workerPool.setRenderOptions({ theme: this.themeNames });
    this.view.setOptions(this.options());
  }

  setFlush(isFlush: boolean): void {
    if (this.isFlush === isFlush) return;
    this.isFlush = isFlush;
    this.root.classList.toggle('flush', isFlush);
    this.view.setOptions(this.options());
  }

  setStyle(diffStyle: DiffStyle): void {
    this.diffStyle = diffStyle;
    this.view.setOptions(this.options());
  }

  scrollToTop(): void {
    this.view.scrollTo({ type: 'position', position: 0, behavior: 'instant' });
  }

  scrollBy(pixels: number): void {
    this.root.scrollTop = Math.max(0, Math.min(this.root.scrollHeight - this.root.clientHeight, this.root.scrollTop + pixels));
  }

  glideBy(pixels: number): void {
    glideScrollTo(this.root, this.root.scrollTop + pixels);
  }

  stepBy(pixels: number): void {
    glideScrollBy(this.root, pixels);
  }

  scrollByPage(fraction: number): void {
    this.scrollBy(this.root.clientHeight * fraction);
  }

  scrollToBottom(): void {
    this.view.scrollTo({ type: 'position', position: this.root.scrollHeight, behavior: 'instant' });
  }

  scrollToLine(id: string, lineNumber: number, side: 'additions' | 'deletions'): void {
    if (this.collapsed.has(id)) this.toggle(id, false);
    this.view.scrollTo({ type: 'line', id, lineNumber, side, align: 'center', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
    this.view.setSelectedLines({ id, range: { start: lineNumber, end: lineNumber, side, endSide: side } });
  }

  clearLineMark(): void {
    this.view.setSelectedLines(null);
  }

  scrollToFile(id: string): void {
    this.view.scrollTo({ type: 'item', id, align: 'start', behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }

  toggle(id: string, isCollapsed = !this.collapsed.has(id)): void {
    const item = this.view.getItem(id);
    if (item?.type !== 'diff') return;
    if (isCollapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    this.view.updateItem({ ...item, collapsed: isCollapsed, version: (item.version ?? 0) + 1 });
    this.callbacks.onToggle(id, isCollapsed);
  }

  setAllCollapsed(isCollapsed: boolean): void {
    this.ids.forEach((id) => {
      if (this.collapsed.has(id) !== isCollapsed) this.toggle(id, isCollapsed);
    });
  }

  private options(): ViewOptions {
    const header = this.header;
    return {
      theme: this.themeNames,
      themeType: this.themeType,
      diffStyle: this.diffStyle,
      diffIndicators: 'bars',
      lineDiffType: 'word-alt',
      hunkSeparators: 'line-info',
      overflow: 'scroll',
      stickyHeaders: true,
      unsafeCSS: this.isFlush ? `${HEADER_CSS}${FLUSH_CSS}` : HEADER_CSS,
      layout: { paddingTop: 0, paddingBottom: 320, gap: this.isFlush ? 0 : 10 },
      renderCodeViewHeader: header == null ? undefined : () => header,
      renderHeaderPrefix: (_fileDiff, context) => chevron(context.item.id, this.collapsed.has(context.item.id)),
    };
  }

  private readonly handleHeaderClick = (event: MouseEvent): void => {
    const path = event.composedPath();
    const isHeader = path.some((node) => node instanceof HTMLElement && node.dataset.diffsHeader === 'default');
    if (!isHeader) return;
    const host = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER');
    const id = host?.querySelector<HTMLElement>('[data-file-id]')?.dataset.fileId;
    if (id != null) this.toggle(id);
  };
}
