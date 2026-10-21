import type { ParsedFile } from './diffs';
import { groupByRules, isTestPath, reconcileGrouping, type FileGroup, type FileGrouping, type GroupableFile, type PromptFile } from './file-groups';

export interface GroupedReviewHooks {
  /** Shows exactly these files in the diff pane, in this order. */
  show(files: readonly ParsedFile[]): void;
  /** Asks the model for a grouping; rejects when AI is unavailable or fails. */
  groupWithAi(files: readonly PromptFile[]): Promise<FileGrouping>;
  isAiAvailable(): boolean;
  escape(text: string): string;
  onToast(message: string, isError?: boolean): void;
}

interface Elements {
  bar: HTMLElement;
  meta: HTMLElement;
  groups: HTMLElement;
  summary: HTMLElement;
  groupedToggle: HTMLButtonElement;
  testsToggle: HTMLButtonElement;
}

const GROUPED_KEY = 'groupedReview';
const HIDE_TESTS_KEY = 'hideTests';
/** Bump when the prompt, model or response shape changes so old groupings are not reused. */
const STORE_KEY = 'aiFileGroupings.v1';
const STORE_LIMIT = 80;

/** FNV-1a over the diff's paths and hunks: the same diff gets the same key, whatever else changed on the PR. */
export function diffFingerprint(files: readonly ParsedFile[]): string {
  let hash = 0x811c9dc5;
  let length = 0;
  for (const file of files) {
    const text = `${file.diff.name}\u0000${patchOf(file)}\u0001`;
    length += text.length;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${files.length}:${length}:${hash.toString(36)}`;
}

/** AI groupings saved per diff fingerprint, newest last, so reopening a PR or restarting the app never re-runs the model. */
class GroupingStore {
  private entries: Record<string, FileGrouping>;

  constructor() {
    try {
      this.entries = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, FileGrouping>;
    } catch {
      this.entries = {};
    }
  }

  get(key: string): FileGrouping | undefined {
    return this.entries[key];
  }

  set(key: string, grouping: FileGrouping): void {
    const { [key]: _previous, ...rest } = this.entries;
    const kept = Object.entries(rest).slice(-(STORE_LIMIT - 1));
    this.entries = { ...Object.fromEntries(kept), [key]: grouping };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.entries));
    } catch {
      // Storage full: keep it in memory for this session.
    }
  }
}

const toGroupable = (file: ParsedFile): GroupableFile => ({ path: file.diff.name, additions: file.additions, deletions: file.deletions, isBinary: file.diff.hunks.length === 0 && file.diff.type !== 'rename-pure' });

/** Rebuilds unified-diff text for the prompt from the parsed hunks (context, then deletions before additions). */
export function patchOf(file: ParsedFile): string {
  const { additionLines, deletionLines } = file.diff;
  const clean = (line: string | undefined): string => (line ?? '').replace(/\n$/, '');
  return file.diff.hunks
    .map((hunk) => {
      const header = `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@${hunk.hunkContext == null ? '' : ` ${hunk.hunkContext}`}`;
      const body = hunk.hunkContent.flatMap((content) => {
        if (content.type === 'context') return Array.from({ length: content.lines }, (_, offset) => ` ${clean(additionLines[content.additionLineIndex + offset])}`);
        return [
          ...Array.from({ length: content.deletions }, (_, offset) => `-${clean(deletionLines[content.deletionLineIndex + offset])}`),
          ...Array.from({ length: content.additions }, (_, offset) => `+${clean(additionLines[content.additionLineIndex + offset])}`),
        ];
      });
      return [header, ...body].join('\n');
    })
    .join('\n');
}

/** The little Markdown model summaries use: `code` and **bold**, on escaped text. */
function inlineMarkdown(text: string, escape: (text: string) => string): string {
  return escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

/**
 * The review bar above the diff: Grouped shows one pulls.review-style group of related files at a time, with its
 * summary; Hide tests drops test files. Groupings come from rules instantly, then from AI when it's available.
 */
export class GroupedReview {
  private readonly elements: Elements;
  private readonly hooks: GroupedReviewHooks;
  private isGrouped = localStorage.getItem(GROUPED_KEY) === '1';
  private isHidingTests = localStorage.getItem(HIDE_TESTS_KEY) !== '0';
  private files: ParsedFile[] = [];
  private fingerprint = '';
  private aiState: 'idle' | 'loading' | 'failed' = 'idle';
  private grouping: FileGrouping | null = null;
  private activeIndex = 0;
  private readonly store = new GroupingStore();
  private readonly inFlight = new Map<string, Promise<FileGrouping>>();
  private token = 0;

  constructor(elements: Elements, hooks: GroupedReviewHooks) {
    this.elements = elements;
    this.hooks = hooks;
    elements.groupedToggle.addEventListener('click', () => this.toggleGrouped());
    elements.testsToggle.addEventListener('click', () => this.toggleHideTests());
    elements.groups.addEventListener('click', (event) => {
      const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-group-index]')?.dataset.groupIndex);
      if (Number.isInteger(index)) this.selectGroup(index);
    });
    this.syncToggles();
  }

  get isActive(): boolean {
    return this.isGrouped;
  }

  /** Called whenever a PR's diff finishes loading. Returns the files the diff pane should show. */
  load(files: readonly ParsedFile[]): ParsedFile[] {
    this.token += 1;
    this.files = [...files];
    this.fingerprint = diffFingerprint(this.files);
    this.aiState = this.inFlight.has(this.fingerprint) ? 'loading' : 'idle';
    const saved = this.hooks.isAiAvailable() ? this.store.get(this.fingerprint) : undefined;
    this.grouping = reconcileGrouping(saved ?? groupByRules(this.files.map(toGroupable)), this.files.map(toGroupable));
    this.activeIndex = this.startIndex();
    this.elements.bar.hidden = files.length === 0;
    if (this.isGrouped) void this.upgradeToAi();
    this.render();
    return this.visibleFiles();
  }

  clear(): void {
    this.token += 1;
    this.files = [];
    this.grouping = null;
    this.elements.bar.hidden = true;
  }

  toggleGrouped(): void {
    this.isGrouped = !this.isGrouped;
    localStorage.setItem(GROUPED_KEY, this.isGrouped ? '1' : '0');
    this.activeIndex = this.startIndex();
    if (this.isGrouped) void this.upgradeToAi();
    this.apply();
    this.hooks.onToast(this.isGrouped ? 'Grouped review on · ⌥] / ⌥[ switch groups' : 'Grouped review off');
  }

  toggleHideTests(): void {
    this.isHidingTests = !this.isHidingTests;
    localStorage.setItem(HIDE_TESTS_KEY, this.isHidingTests ? '1' : '0');
    this.activeIndex = Math.min(this.activeIndex, Math.max(0, this.visibleGroups().length - 1));
    this.apply();
    const hidden = this.files.filter((file) => isTestPath(file.diff.name)).length;
    this.hooks.onToast(this.isHidingTests ? `Hiding test files${hidden > 0 ? ` (${hidden} in this PR)` : ''}` : 'Showing test files');
  }

  /** Moves to the next or previous group; returns false when grouping is off so the caller can fall through. */
  moveGroup(delta: -1 | 1): boolean {
    if (!this.isGrouped) return false;
    const count = this.visibleGroups().length;
    if (count === 0) return true;
    this.selectGroup((this.activeIndex + delta + count) % count);
    return true;
  }

  /** Brings a file into view (for a thread jump): selects its group and stops hiding tests if it is one. */
  reveal(path: string): void {
    if (this.isHidingTests && isTestPath(path)) {
      this.isHidingTests = false;
      localStorage.setItem(HIDE_TESTS_KEY, '0');
    }
    if (this.isGrouped) {
      const index = this.visibleGroups().findIndex((group) => group.paths.includes(path));
      if (index >= 0) this.activeIndex = index;
    }
    this.apply();
  }

  private selectGroup(index: number): void {
    this.activeIndex = index;
    this.apply();
  }

  private apply(): void {
    this.syncToggles();
    this.render();
    this.hooks.show(this.visibleFiles());
  }

  /** Runs the model once per diff: a saved grouping or a request already in flight is reused, never repeated. */
  private async upgradeToAi(): Promise<void> {
    if (!this.hooks.isAiAvailable() || this.files.length < 2 || this.grouping?.source === 'ai') return;
    const token = this.token;
    const key = this.fingerprint;
    const saved = this.store.get(key);
    let pending = saved == null ? this.inFlight.get(key) : Promise.resolve(saved);
    if (pending == null) {
      pending = this.hooks.groupWithAi(this.files.map((file) => ({ ...toGroupable(file), patch: patchOf(file) })));
      this.inFlight.set(key, pending);
      void pending.then((grouping) => this.store.set(key, grouping), () => undefined).finally(() => this.inFlight.delete(key));
    }
    if (saved == null) {
      this.aiState = 'loading';
      this.render();
    }
    try {
      const grouping = await pending;
      if (token !== this.token) return;
      this.aiState = 'idle';
      this.adopt(grouping);
    } catch (error) {
      if (token !== this.token) return;
      this.aiState = 'failed';
      this.render();
      console.warn('AI grouping failed', error instanceof Error ? error.message : String(error));
    }
  }

  private adopt(grouping: FileGrouping): void {
    const activeKey = this.visibleGroups()[this.activeIndex]?.key;
    this.grouping = reconcileGrouping(grouping, this.files.map(toGroupable));
    const restored = this.visibleGroups().findIndex((group) => group.key === activeKey);
    this.activeIndex = restored >= 0 ? restored : 0;
    if (this.isGrouped) this.apply();
    else this.render();
  }

  /** AI groups are already in review order; rule groups list Docs first, so start on Code when there is one. */
  private startIndex(): number {
    if (this.grouping?.source === 'ai') return 0;
    return Math.max(0, this.visibleGroups().findIndex((group) => group.key === 'code'));
  }

  /** Groups with their test files removed when Hide tests is on; groups left empty disappear. */
  private visibleGroups(): FileGroup[] {
    const groups = this.grouping?.groups ?? [];
    if (!this.isHidingTests) return groups;
    return groups.map((group) => ({ ...group, paths: group.paths.filter((path) => !isTestPath(path)) })).filter((group) => group.paths.length > 0);
  }

  visibleFiles(): ParsedFile[] {
    const allowed = this.isHidingTests ? this.files.filter((file) => !isTestPath(file.diff.name)) : this.files;
    if (!this.isGrouped) return allowed;
    const group = this.visibleGroups()[this.activeIndex];
    if (group == null) return allowed;
    const byPath = new Map(allowed.map((file) => [file.diff.name, file]));
    return group.paths.flatMap((path) => byPath.get(path) ?? []);
  }

  private syncToggles(): void {
    this.elements.groupedToggle.classList.toggle('active', this.isGrouped);
    this.elements.groupedToggle.setAttribute('aria-pressed', String(this.isGrouped));
    this.elements.testsToggle.classList.toggle('active', this.isHidingTests);
    this.elements.testsToggle.setAttribute('aria-pressed', String(this.isHidingTests));
  }

  private render(): void {
    const escape = this.hooks.escape;
    const hiddenTests = this.isHidingTests ? this.files.filter((file) => isTestPath(file.diff.name)).length : 0;
    const isLoading = this.isGrouped && this.aiState === 'loading';
    const source = this.grouping?.source === 'ai' ? 'AI groups' : this.aiState === 'failed' ? 'AI grouping failed · showing rule groups' : this.isGrouped && this.hooks.isAiAvailable() ? 'Rule groups' : '';
    this.elements.bar.classList.toggle('ai-loading', isLoading);
    const tests = hiddenTests > 0 ? `${hiddenTests} test file${hiddenTests === 1 ? '' : 's'} hidden` : '';
    if (isLoading) this.elements.meta.innerHTML = `<span class="spinner"></span>Grouping by intent…${tests === '' ? '' : ` · ${escape(tests)}`}`;
    else this.renderMeta([tests, this.isGrouped ? source : ''].filter((part) => part !== '').join(' · '));
    const groups = this.visibleGroups();
    this.elements.groups.hidden = !this.isGrouped || groups.length === 0;
    this.elements.summary.hidden = !this.isGrouped || groups.length === 0;
    if (!this.isGrouped) return;
    this.elements.groups.innerHTML = groups
      .map((group, index) => {
        const lines = group.paths.reduce((sum, path) => {
          const file = this.files.find((candidate) => candidate.diff.name === path);
          return sum + (file == null ? 0 : file.additions + file.deletions);
        }, 0);
        return `<button type="button" class="review-group${index === this.activeIndex ? ' active' : ''}${group.isCritical ? ' critical' : ''}" data-group-index="${index}" data-category="${escape(group.category)}" title="${escape(group.summary)}"><i class="review-group-dot"></i><span class="review-group-label">${escape(group.label)}</span><span class="review-group-count">${group.paths.length} · ${lines}</span></button>`;
      })
      .join('');
    const active = groups[this.activeIndex];
    const overall = this.grouping?.overallSummary;
    const markdown = (text: string): string => inlineMarkdown(text, escape);
    if (isLoading) {
      this.elements.summary.innerHTML = `<div class="review-loading skeleton" aria-busy="true"><span class="sk-line" style="width:88%"></span><span class="sk-line" style="width:64%"></span><span class="review-loading-note muted">Reading the diff to group files by intent. Rule groups below work in the meantime.</span></div>`;
      return;
    }
    this.elements.summary.innerHTML = active == null ? '' : `${this.activeIndex === 0 && overall != null && overall !== '' ? `<div class="review-overall">${markdown(overall)}</div>` : ''}<div class="review-group-text"><b>${escape(active.label)}</b>${active.isCritical ? '<span class="review-critical">Review carefully</span>' : ''} ${markdown(active.summary)}</div><div class="review-group-step muted">Group ${this.activeIndex + 1} of ${groups.length} · <kbd>⌥</kbd><kbd>]</kbd> next · <kbd>⌥</kbd><kbd>[</kbd> previous</div>`;
    this.elements.groups.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private renderMeta(text: string): void {
    this.elements.meta.textContent = text;
  }
}
