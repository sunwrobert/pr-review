import { hydrateIcons, icon } from './icons';
import { attachScrollFade } from './scroll-fade';
import { startAutoUpdate } from './updater';
import { StableOrder } from './stable-order';
import { forgetThreads, loadThreads, replyToThread, setThreadResolved, type ReviewThread } from './threads';
import { findInDiff, findInDom, type FindHit } from './find-in-pr';
import { applyPastedOrder, parsePastedOrder, type PastedOrder } from './pasted-order';
import { watchKbdGlyphs } from './kbd-glyphs';
import { animateDialogCancel, flash, glideScrollBy, glideScrollTo, setVisibleWithMotion } from './motion';
import { ATTENTION_META, ATTENTION_ORDER, attentionReasons, buildAgentPrompt, isConflicted, isFailing, needsAttention, prStatus, type AttentionReason } from './status';
import { applyThemeColors, SYSTEM_THEME_ID, THEMES, themeById, type AppTheme } from './themes';
import { ThemePicker } from './theme-picker';
import './styles.css';
import { approvePull, commentOnPull, messageDevinSession, fetchViewerLogin, usesMergeQueue, fetchBody, fetchDiff, fetchMergeStates, fetchQueue, type MergeState, mergePull, openInBrowser, type MergeMethod, type PullRequest, type QueueKind } from './github';
import { DiffView, parseDiff, type DiffStyle, type ParsedFile } from './diffs';
import { sanitizeHtml } from './sanitize';
import { CommandRegistry, renderShortcut, type Command } from './commands';
import { Layout, type LayoutPreset } from './layout';
import { Lightbox, collectMedia } from './lightbox';
import { enableWindowDrag } from './window-drag';
import { enableTooltips } from './tooltip';
import { groupPulls, type PullGroup } from './grouping';
import { adoptImages, imageUrlsInHtml, preloadImages } from './image-cache';
import { routeLinksToBrowser } from './external-links';
import { isSemanticMatch, semanticMatches } from './semantic-search';
import { VirtualList, type VirtualRow } from './virtual-list';
import { invalidateConversation, loadConversation, type ConversationItem } from './conversation';
import { isReady, isRecent, isSmall, matchesSmartFilter, sortPulls, type SmartFilter, type SortOrder } from './smart';
import { assessReadiness, isReadinessAvailable, type ReadinessResult } from './readiness';

interface State {
  kind: QueueKind;
  pulls: PullRequest[];
  filter: string;
  smartFilter: SmartFilter;
  sortOrder: SortOrder;
  checkedIds: Set<string>;
  selectedId: string | null;
  activeFileIndex: number;
  diffStyle: DiffStyle;
}

const PREFETCH_AHEAD = 5;
const DIFF_CACHE_LIMIT = 24;
const QUEUE_REFRESH_MS = 120_000;
const VIEW_TITLES: Record<QueueKind, string> = { review: 'Review requested', involved: 'Involved', mine: 'Created by me' };
const MERGE_LABELS: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Merge', rebase: 'Rebase and merge' };

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found == null) throw new Error(`missing #${id}`);
  return found as T;
};

hydrateIcons();

const dom = {
  list: element<HTMLOListElement>('pr-list'),
  filter: element<HTMLInputElement>('filter'),
  viewTitle: element('view-title'),
  empty: element('empty'),
  pr: element('pr'),
  crumbs: element('crumbs'),
  statusBar: element('status-bar'),
  descPane: element('desc-pane'),
  inspector: element('inspector'),
  bodySplit: element('pr-body-split'),
  files: element('files'),
  fileCount: element('file-count'),
  diffRoot: element('diff-root'),
  approve: element<HTMLButtonElement>('approve'),
  merge: element<HTMLButtonElement>('merge'),
  confirm: element<HTMLDialogElement>('confirm'),
  confirmTitle: element('confirm-title'),
  confirmText: element('confirm-text'),
  help: element<HTMLDialogElement>('help'),
  shortcutList: element('shortcut-list'),
  sort: element<HTMLSelectElement>('sort'),
  filterBar: element('filter-bar'),
  bulkBar: element('bulk-bar'),
  bulkCount: element('bulk-count'),
  bulkMerge: element<HTMLButtonElement>('bulk-merge'),
  bulkApprove: element<HTMLButtonElement>('bulk-approve'),
  commentDialog: element<HTMLDialogElement>('comment-dialog'),
  commentTitle: element('comment-title'),
  commentBody: element<HTMLTextAreaElement>('comment-body'),
  commentHint: element('comment-hint'),
  commentSend: element<HTMLButtonElement>('comment-send'),
  commentSendLabel: element('comment-send-label'),
  bulkConfirm: element<HTMLDialogElement>('bulk-confirm'),
  triage: element<HTMLDialogElement>('triage'),
  triageTitle: element('triage-title'),
  triageSections: element('triage-sections'),
  triageCopy: element<HTMLButtonElement>('triage-copy'),
  triageDevin: element<HTMLButtonElement>('triage-devin'),
  triageMessage: element<HTMLTextAreaElement>('triage-message'),
  bulkConfirmTitle: element('bulk-confirm-title'),
  bulkConfirmList: element('bulk-confirm-list'),
  bulkConfirmNote: element('bulk-confirm-note'),
  toast: element('toast'),
};

const state: State = {
  kind: 'mine',
  pulls: [],
  filter: '',
  smartFilter: ((['all', 'ready', 'attention', 'threads'] as const).find((filter) => filter === localStorage.getItem('smartFilter')) ?? 'all') as SmartFilter,
  sortOrder: (localStorage.getItem('sortOrder') as SortOrder | null) ?? 'smart',
  checkedIds: new Set<string>(),
  selectedId: null,
  activeFileIndex: 0,
  diffStyle: localStorage.getItem('diffStyle') === 'unified' ? 'unified' : 'split',
};

let viewer: string | null = null;
const diffCache = new Map<string, Promise<ParsedFile[]>>();
const queueCache = new Map<QueueKind, PullRequest[]>();
let isSelectedQueued = false;
const diffView = new DiffView(dom.diffRoot, state.diffStyle, { onToggle: (id, isCollapsed) => markFileCollapsed(id, isCollapsed) });
let currentFiles: ParsedFile[] = [];
let renderToken = 0;
let toastTimer: number | undefined;

const MERGE_ICON = icon('merge');

const MERGE_METHOD: MergeMethod = 'squash';
syncMergeLabel();


function syncMergeLabel(): void {
  const selectedCount = state.checkedIds.size;
  const baseLabel = isSelectedQueued ? 'Merge when ready' : MERGE_LABELS[MERGE_METHOD];
  const label = selectedCount > 0 ? `${isSelectedQueued ? 'Queue' : 'Merge'} ${selectedCount} selected` : baseLabel;
  dom.merge.innerHTML = `${MERGE_ICON}${selectedCount > 0 ? `<span class="merge-count">${selectedCount}</span>` : ''}<kbd>⌘</kbd><kbd>↵</kbd>`;
  dom.merge.title = `${label}  ⌘↵`;
}

type ToastTone = 'info' | 'success' | 'error';

const TOAST_ICONS: Record<ToastTone, string> = {
  info: icon('info'),
  success: icon('circleCheck'),
  error: icon('circleAlert'),
};
const SUCCESS_PATTERN = /^(approved|merged|queued|copied|added|#\d+ (queued|added))/i;

function toast(message: string, isError = false): void {
  const tone: ToastTone = isError ? 'error' : SUCCESS_PATTERN.test(message) ? 'success' : 'info';
  dom.toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[tone]}</span><span class="toast-text"></span>`;
  const text = dom.toast.querySelector('.toast-text');
  if (text != null) text.textContent = message;
  dom.toast.className = `show ${tone}`;
  toastLifetimeMs = isError ? 9000 : 4500;
  scheduleToastHide();
}

let toastLifetimeMs = 4500;

document.addEventListener('pointerdown', (event) => {
  if (dom.toast.contains(event.target as Node)) return;
  const selection = window.getSelection();
  if (selection != null && dom.toast.contains(selection.anchorNode)) selection.removeAllRanges();
}, true);

function scheduleToastHide(): void {
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    const hasSelection = dom.toast.contains(window.getSelection()?.anchorNode ?? null) && window.getSelection()?.isCollapsed === false;
    if (dom.toast.matches(':hover') || hasSelection) {
      scheduleToastHide();
      return;
    }
    dom.toast.classList.remove('show');
  }, toastLifetimeMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

function diffKey(pull: PullRequest): string {
  return `${pull.id}:${pull.updatedAt}`;
}

const bodyCache = new Map<string, Promise<string>>();

function loadBody(pull: PullRequest, isPriority = false): Promise<string> {
  const key = diffKey(pull);
  const cached = bodyCache.get(key);
  if (cached != null) {
    void cached.then((html) => preloadImages(imageUrlsInHtml(html), isPriority), () => undefined);
    return cached;
  }
  const pending = fetchBody(pull).then((html) => {
    preloadImages(imageUrlsInHtml(html), isPriority);
    return html;
  });
  pending.catch(() => bodyCache.delete(key));
  bodyCache.set(key, pending);
  if (bodyCache.size > DIFF_CACHE_LIMIT) bodyCache.delete(bodyCache.keys().next().value ?? '');
  return pending;
}

function loadDiff(pull: PullRequest): Promise<ParsedFile[]> {
  const key = diffKey(pull);
  const cached = diffCache.get(key);
  if (cached != null) return cached;
  const pending = fetchDiff(pull).then(
    (patch) =>
      new Promise<ParsedFile[]>((resolve, reject) => {
        const parse = (): void => {
          try {
            resolve(parseDiff(key, patch));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        if (patch.length < 200_000) parse();
        else requestAnimationFrame(() => window.setTimeout(parse, 0));
      }),
  );
  pending.catch(() => diffCache.delete(key));
  diffCache.set(key, pending);
  if (diffCache.size > DIFF_CACHE_LIMIT) diffCache.delete(diffCache.keys().next().value ?? '');
  return pending;
}

const SEMANTIC_DEBOUNCE_MS = 450;
const SEMANTIC_MIN_CHARS = 3;
let semanticQuery = '';
let semanticScores = new Map<string, number>();
let isSemanticLoading = false;
let semanticTimer: number | undefined;
let semanticAbort: AbortController | null = null;

function literalMatch(pull: PullRequest, needle: string): boolean {
  return `${pull.title} ${pull.repository.nameWithOwner} #${pull.number} ${pull.author?.login ?? ''} ${pull.headRefName}`.toLowerCase().includes(needle);
}

function matchesText(pull: PullRequest, needle: string): boolean {
  if (needle === '') return true;
  if (literalMatch(pull, needle)) return true;
  return semanticQuery === needle && isSemanticMatch(semanticScores.get(pull.id));
}

function renderSearchState(): void {
  const box = dom.filter.closest('.search');
  box?.classList.toggle('searching', isSemanticLoading);
  renderListEmpty(filteredPulls().length, state.filter.trim().toLowerCase());
}

function scheduleSemanticSearch(): void {
  window.clearTimeout(semanticTimer);
  semanticAbort?.abort();
  const needle = state.filter.trim().toLowerCase();
  if (!isAiEnabled || needle.length < SEMANTIC_MIN_CHARS || /^#?\d+$/.test(needle)) {
    isSemanticLoading = false;
    renderSearchState();
    return;
  }
  semanticTimer = window.setTimeout(() => {
    const controller = new AbortController();
    semanticAbort = controller;
    isSemanticLoading = true;
    renderSearchState();
    void semanticMatches(needle, state.pulls, controller.signal)
      .then((scores) => {
        if (controller.signal.aborted || state.filter.trim().toLowerCase() !== needle) return;
        semanticQuery = needle;
        semanticScores = scores;
        renderList();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('semantic search failed', errorMessage(error));
      })
      .finally(() => {
        if (semanticAbort === controller) {
          isSemanticLoading = false;
          renderSearchState();
        }
      });
  }, SEMANTIC_DEBOUNCE_MS);
}

const stableOrder = new StableOrder();
const PASTED_ORDER_KEY = 'pastedOrder.v1';
let pastedOrder: PastedOrder | null = loadPastedOrder();

function loadPastedOrder(): PastedOrder | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PASTED_ORDER_KEY) ?? 'null') as { numbers: number[]; headings: [number, string][] } | null;
    return saved == null ? null : { numbers: saved.numbers, headings: new Map(saved.headings) };
  } catch {
    return null;
  }
}
const leaving = new Map<string, { pull: PullRequest; label: string; isPending?: boolean }>();
let listCacheKey = '';
let filteredCache: PullRequest[] = [];
let visibleCache: PullRequest[] = [];
let listVersion = 0;

function invalidateList(): void {
  listVersion += 1;
}

function currentListKey(): string {
  return [listVersion, leaving.size, pastedOrder?.numbers.length ?? -1, state.pulls, state.filter, state.smartFilter, state.sortOrder, isGrouped, groups, semanticQuery, semanticScores, aiResults.size, collapsedGroups.size].map((part) => (typeof part === 'object' ? objectId(part) : String(part))).join('|');
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): string {
  let id = objectIds.get(value);
  if (id == null) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return String(id);
}

function withLeaving(ranked: PullRequest[]): PullRequest[] {
  if (leaving.size === 0) return ranked;
  const present = new Set(ranked.map((pull) => pull.id));
  return [...ranked, ...[...leaving.values()].filter((entry) => !present.has(entry.pull.id)).map((entry) => entry.pull)];
}

function computeLists(): void {
  const key = currentListKey();
  if (key === listCacheKey) return;
  listCacheKey = key;
  const needle = state.filter.trim().toLowerCase();
  const now = Date.now();
  const matching = state.pulls.filter((pull) => (state.smartFilter === 'attention' ? isMergeStateSettled(pull) && needsAttention(pull) : state.smartFilter === 'tested' ? isTested(pull) : matchesSmartFilter(pull, state.smartFilter, now)) && matchesText(pull, needle));
  const ranked = sortPulls(matching, state.sortOrder, now, aiScoreFor);
  filteredCache = pastedOrder != null ? withLeaving(applyPastedOrder(ranked, pastedOrder)) : stableOrder.apply(withLeaving(ranked), [state.kind, state.smartFilter, state.sortOrder, needle, isGrouped].join('|'));
  visibleCache = !isGrouped || groups.length === 0 ? filteredCache : listSections(filteredCache).flatMap((section) => (section.group != null && collapsedGroups.has(section.group.id) ? [] : section.pulls));
}

function filteredPulls(): PullRequest[] {
  computeLists();
  return filteredCache;
}

function visiblePulls(): PullRequest[] {
  computeLists();
  return visibleCache;
}

let smartCountsSource: PullRequest[] | null = null;
let lastStatesVersion = -1;

function renderSmartCounts(): void {
  if (smartCountsSource === state.pulls && lastStatesVersion === listVersion && dom.sort.value === state.sortOrder && dom.filterBar.querySelector('.chip.active')?.getAttribute('data-smart') === state.smartFilter) return;
  smartCountsSource = state.pulls;
  lastStatesVersion = listVersion;
  const now = Date.now();
  const counts: Record<SmartFilter, number> = {
    all: state.pulls.length,
    ready: state.pulls.filter(isReady).length,
    small: state.pulls.filter(isSmall).length,
    recent: state.pulls.filter((pull) => isRecent(pull, now)).length,
    attention: state.pulls.filter((pull) => isMergeStateSettled(pull) && needsAttention(pull)).length,
    threads: state.pulls.filter((pull) => (pull.openThreads ?? 0) > 0).length,
    tested: state.pulls.filter(isTested).length,
  };
  dom.filterBar.querySelectorAll<HTMLElement>('[data-smart-count]').forEach((badge) => (badge.textContent = String(counts[badge.dataset.smartCount as SmartFilter])));
  dom.filterBar.querySelectorAll<HTMLElement>('[data-smart]').forEach((chip) => chip.classList.toggle('active', chip.dataset.smart === state.smartFilter));
  dom.sort.value = state.sortOrder;
}

let pullIndexSource: PullRequest[] | null = null;
let pullIndex = new Map<string, PullRequest>();

function pullById(id: string | null): PullRequest | undefined {
  if (id == null) return undefined;
  if (pullIndexSource !== state.pulls) {
    pullIndexSource = state.pulls;
    pullIndex = new Map(state.pulls.map((pull) => [pull.id, pull]));
  }
  return pullIndex.get(id);
}

function selectedPull(): PullRequest | undefined {
  return pullById(state.selectedId);
}

function queueLabel(pull: PullRequest): string {
  const entry = pull.queueEntry;
  if (entry == null) return '';
  const phase = entry.state === 'AWAITING_CHECKS' ? 'running checks' : entry.state === 'MERGEABLE' ? 'merging' : entry.state === 'UNMERGEABLE' ? 'failed' : entry.state.toLowerCase().replace(/_/g, ' ');
  return `In merge queue · #${entry.position + 1} · ${phase}`;
}

function statusIcon(pull: PullRequest): string {
  const status = prStatus(pull);
  return `<span class="status ${status.tone}" title="${escapeHtml(status.tone === 'queued' ? queueLabel(pull) : status.label)}"></span>`;
}

function checksIcon(pull: PullRequest): string {
  if (pull.failingRequired != null && (pull.checkState === 'FAILURE' || pull.checkState === 'ERROR')) {
    if (pull.failingRequired.length > 0) return `<span class="check bad" title="Required checks failing: ${escapeHtml(pull.failingRequired.join(', '))}">${icon('x')}</span>`;
    return `<span class="check ok" title="Required checks passed${pull.failingOptional != null && pull.failingOptional > 0 ? ` · ${pull.failingOptional} optional failed` : ''}">${icon('check')}</span>`;
  }
  switch (pull.checkState) {
    case 'SUCCESS':
      return `<span class="check ok" title="Checks passed">${icon('check')}</span>`;
    case 'FAILURE':
    case 'ERROR':
      return `<span class="check bad" title="Checks failed">${icon('x')}</span>`;
    case 'PENDING':
    case 'EXPECTED':
      return `<span class="check wait" title="Checks running">${icon('circleDashed')}</span>`;
    case null:
      return '';
    default:
      return pull.checkState satisfies never;
  }
}

function readinessDot(pull: PullRequest): string {
  const score = aiScoreFor(pull);
  if (score == null) return '';
  const percent = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const toneName = percent >= 65 ? 'ok' : percent >= 40 ? 'wait' : 'bad';
  return `<span class="ai-score ${toneName}" title="Readiness ${percent}%">${percent}</span>`;
}

function avatar(pull: PullRequest): string {
  const url = pull.author?.avatarUrl;
  return url == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(url)}&s=40" alt="" decoding="async" />`;
}

function repoName(pull: PullRequest): string {
  return pull.repository.nameWithOwner.split('/')[1] ?? pull.repository.nameWithOwner;
}

function mostCommonRepo(): string | undefined {
  const counts = new Map<string, number>();
  state.pulls.forEach((pull) => counts.set(pull.repository.nameWithOwner, (counts.get(pull.repository.nameWithOwner) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function repoTag(pull: PullRequest, primaryRepo: string | undefined): string {
  if (pull.repository.nameWithOwner === primaryRepo) return '';
  return `<span class="repo-tag">${escapeHtml(repoName(pull).replace(/^terraform-provider-/, 'tf-'))}</span>`;
}

function renderCounts(): void {
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((badge) => {
    const pulls = queueCache.get(badge.dataset.count as QueueKind);
    badge.textContent = pulls == null ? '' : String(pulls.length);
  });
}

const GROUPS_CACHE_KEY = 'jevGroups.v2';
let isGrouped = localStorage.getItem('grouped') === '1';
let groups: PullGroup[] = [];
let groupsSignature = '';
let isGrouping = false;
const collapsedGroups = new Set<string>(JSON.parse(localStorage.getItem('collapsedGroups') ?? '[]') as string[]);

function pullsSignature(pulls: readonly PullRequest[]): string {
  return pulls.map((pull) => pull.id).sort().join(',');
}

function loadCachedGroups(pulls: readonly PullRequest[]): void {
  try {
    const cached = JSON.parse(localStorage.getItem(GROUPS_CACHE_KEY) ?? 'null') as { signature: string; groups: PullGroup[] } | null;
    if (cached?.signature === pullsSignature(pulls)) {
      groups = cached.groups;
      groupsSignature = cached.signature;
    }
  } catch {
    groups = [];
  }
}

async function ensureGroups(isUserInitiated = false): Promise<void> {
  const signature = pullsSignature(state.pulls);
  if (!isGrouped || !isAiEnabled || isGrouping || signature === groupsSignature || state.pulls.length < 2) return;
  loadCachedGroups(state.pulls);
  if (groupsSignature === signature) return renderList();
  isGrouping = true;
  renderList();
  try {
    groups = await groupPulls(state.pulls);
    groupsSignature = signature;
    localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify({ signature, groups }));
    if (isUserInitiated) toast(`Grouped related work into ${groups.length} group${groups.length === 1 ? '' : 's'}`);
  } catch (error) {
    if (isUserInitiated) toast(`Grouping failed: ${errorMessage(error)}`, true);
    else console.warn('background regroup failed', errorMessage(error));
  } finally {
    isGrouping = false;
    renderList();
  }
}

function toggleGrouping(): void {
  if (!isAiEnabled) {
    toast('Grouping needs OPENROUTER_API_KEY.', true);
    return;
  }
  isGrouped = !isGrouped;
  localStorage.setItem('grouped', isGrouped ? '1' : '0');
  renderList();
  if (!isGrouped) toast('Grouping off');
  void ensureGroups(true);
}

function averageReadiness(pulls: PullRequest[]): number {
  const now = Date.now();
  const scores = pulls.map((pull) => aiScoreFor(pull) ?? (isReady(pull) ? 0.6 : 0.2) - Math.min(0.2, (now - Date.parse(pull.updatedAt)) / 8.64e8));
  return scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length);
}

interface ListSection {
  group: PullGroup | null;
  pulls: PullRequest[];
}

function pastedSections(pulls: PullRequest[], order: PastedOrder): ListSection[] {
  const sections: ListSection[] = [];
  for (const pull of pulls) {
    const label = order.headings.get(pull.number) ?? (order.numbers.includes(pull.number) ? 'Pasted order' : 'Not in pasted list');
    const last = sections.at(-1);
    if (last?.group?.label === label) last.pulls.push(pull);
    else sections.push({ group: { id: `pasted:${sections.length}:${label}`, label, pullIds: [] }, pulls: [pull] });
  }
  sections.forEach((section) => section.group != null && (section.group.pullIds = section.pulls.map((pull) => pull.id)));
  return sections;
}

function listSections(pulls: PullRequest[]): ListSection[] {
  if (pastedOrder != null) return pastedSections(pulls, pastedOrder);
  if (!isGrouped || groups.length === 0) return [{ group: null, pulls }];
  const averages = new Map<string, number>();
  const averageFor = (section: ListSection): number => {
    const id = section.group?.id ?? '';
    const cached = averages.get(id);
    if (cached != null) return cached;
    const value = averageReadiness(section.pulls);
    averages.set(id, value);
    return value;
  };
  const order = new Map(pulls.map((pull, index) => [pull.id, index]));
  const assigned = new Set<string>();
  const sections = groups
    .map((group): ListSection => {
      const members = group.pullIds.filter((id) => order.has(id)).sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
      members.forEach((id) => assigned.add(id));
      return { group, pulls: members.map((id) => pulls[order.get(id) ?? 0] as PullRequest) };
    })
    .filter((section) => section.pulls.length > 0)
    .sort((left, right) => averageFor(right) - averageFor(left));
  const rest = pulls.filter((pull) => !assigned.has(pull.id));
  if (rest.length > 0) sections.push({ group: { id: 'ungrouped', label: 'Other', pullIds: rest.map((pull) => pull.id) }, pulls: rest });
  return sections;
}

function groupHeader(section: ListSection): string {
  const group = section.group;
  if (group == null) return '';
  const isCollapsed = collapsedGroups.has(group.id);
  return `<li class="group-row${isCollapsed ? ' collapsed' : ''}" data-group="${escapeHtml(group.id)}">
    <span class="caret">${icon('chevronRight')}</span>
    <span class="group-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
    <button class="group-select" data-group-select="${escapeHtml(group.id)}" title="Select all ${section.pulls.length} in group">Select</button>
  </li>`;
}

const ROW_HEIGHT = 40;
const GROUP_ROW_HEIGHT = 34;
const STATUS_ROW_HEIGHT = 34;
const virtualList = new VirtualList(dom.list);

function rowHtml(pull: PullRequest, primaryRepo: string | undefined, needle: string): string {
  const isChecked = state.checkedIds.has(pull.id);
  const exit = leaving.get(pull.id);
  return `<li data-key="${pull.id}" data-id="${pull.id}" class="${pull.id === state.selectedId ? 'selected' : ''}${isChecked ? ' checked' : ''}${pull.queueEntry != null ? ' queued' : ''}${exit != null ? ' leaving' : ''}${exit?.isPending === true ? ' pending' : ''}${failedMerges.has(pull.id) ? ' merge-failed' : ''}"${exit != null ? ` data-leaving="${escapeHtml(exit.label)}"` : ''}>
        <span class="check-box" data-check="${pull.id}" role="checkbox" aria-checked="${isChecked}" title="Select  E / ⇧V"></span>
        ${statusIcon(pull)}
        <span class="id" title="${escapeHtml(pull.repository.nameWithOwner)}">${repoTag(pull, primaryRepo)}#${pull.number}</span>
        <span class="t">${escapeHtml(pull.title)}</span>
        <span class="right">${(pull.openThreads ?? 0) > 0 ? `<span class="thread-pill" title="${pull.openThreads} unresolved thread${pull.openThreads === 1 ? '' : 's'}  ⇧C">${icon('comment')}${pull.openThreads}</span>` : ''}${pull.queueEntry != null ? `<span class="queue-pill" title="${escapeHtml(queueLabel(pull))}">Queued</span>` : ''}${readinessDot(pull)}${checksIcon(pull)}<span class="delta"><i class="add">+${pull.additions}</i> <i class="del">−${pull.deletions}</i></span><span class="age">${relativeTime(pull.updatedAt)}</span>${avatar(pull)}</span>
      </li>`;
}

function renderListEmpty(count: number, needle: string): void {
  const box = document.getElementById('list-empty');
  if (box == null) return;
  const isBooting = !lastFetchedAt.has(state.kind) && state.pulls.length === 0;
  const isSearching = needle !== '' && isSemanticLoading;
  const isAwaiting = count === 0 && state.pulls.length > 0 && isAwaitingMergeStates();
  const kind = count > 0 || isBooting ? '' : isSearching ? 'searching' : isAwaiting ? 'checking' : state.pulls.length === 0 ? 'empty' : needle !== '' ? 'no-results' : 'filtered';
  if (box.dataset.kind === kind) return;
  box.dataset.kind = kind;
  const filterLabel = state.smartFilter === 'ready' ? 'Ready' : state.smartFilter === 'attention' ? 'Unready' : state.smartFilter === 'threads' ? 'waiting on review threads' : state.smartFilter;
  const views: Record<string, string> = {
    searching: `${icon('search', 'empty-ico')}<b>Searching…</b><span>Looking for “${escapeHtml(needle)}”</span><div class="empty-skel"><span></span><span></span><span></span></div>`,
    checking: `<div class="empty-overlay"><b>Checking merge status…</b><span>Asking GitHub which PRs are ready to merge</span></div>`,
    'no-results': `${icon('search', 'empty-ico')}<b>No pull requests match “${escapeHtml(needle)}”</b><span>Try another word, or clear the filter</span><button type="button" class="ghost" data-empty-action="clear-filter">Clear filter <kbd>esc</kbd></button>`,
    filtered: `${icon('circleCheck', 'empty-ico')}<b>Nothing is ${escapeHtml(filterLabel)} right now</b><span>Everything else is still in All</span><button type="button" class="ghost" data-empty-action="show-all">Show all <kbd>⌥</kbd><kbd>0</kbd></button>`,
    empty: `${icon('circleCheck', 'empty-ico')}<b>Inbox zero</b><span>No open pull requests in this view</span>`,
  };
  box.innerHTML = kind === '' ? '' : kind === 'checking' ? `<div class="list-checking">${listSkeleton()}${views[kind]}</div>` : `<div class="list-empty-inner">${views[kind]}</div>`;
  box.hidden = kind === '';
}

function renderList(): void {
  const pulls = filteredPulls();
  const primaryRepo = mostCommonRepo();
  const sections = listSections(pulls);
  const needle = state.filter.trim().toLowerCase();
  const rows: VirtualRow[] = [];
  const note = !isGrouped ? '' : isGrouping ? '<span class="spinner"></span>Grouping related work…' : groups.length === 0 ? 'No groups yet · press T again or run “Regroup”' : '';
  if (note !== '') rows.push({ key: 'status', height: STATUS_ROW_HEIGHT, render: () => `<li data-key="status" class="group-status">${note}</li>` });
  for (const section of sections) {
    const group = section.group;
    if (group != null) rows.push({ key: `group:${group.id}`, height: GROUP_ROW_HEIGHT, render: () => groupHeader(section).replace('<li ', `<li data-key="group:${escapeHtml(group.id)}" `) });
    if (section.group != null && collapsedGroups.has(section.group.id)) continue;
    for (const pull of section.pulls) rows.push({ key: pull.id, height: ROW_HEIGHT, render: () => rowHtml(pull, primaryRepo, needle) });
  }
  dom.list.classList.toggle('grouped', isGrouped && groups.length > 0);
  virtualList.setRows(rows);
  renderListEmpty(pulls.length, needle);
  virtualList.highlightKey(pulls.some((pull) => pull.id === state.selectedId) ? state.selectedId : null);
  document.getElementById('toggle-grouping')?.classList.toggle('active', isGrouped);
  renderCounts();
  renderSmartCounts();
  renderBulkBar();
  syncDetailVisibility(pulls);
}

let pendingAutoSelect = 0;

function isAwaitingMergeStates(): boolean {
  if (state.smartFilter !== 'ready' && state.smartFilter !== 'attention') return false;
  return state.pulls.some((pull) => pull.mergeStateStatus === 'UNKNOWN' && !pull.isDraft);
}

function isMergeStateSettled(pull: PullRequest): boolean {
  return pull.isDraft || pull.mergeStateStatus !== 'UNKNOWN';
}

function syncDetailVisibility(pulls: PullRequest[]): void {
  const hasSelection = selectedPull() != null;
  if (state.pulls.length > 0) document.getElementById('list-skeleton')?.remove();
  if (hasSelection) {
    clearBootSkeletons();
    dom.pr.hidden = false;
    dom.empty.hidden = true;
    return;
  }
  const first = pulls[0];
  if (first != null) {
    cancelAnimationFrame(pendingAutoSelect);
    pendingAutoSelect = requestAnimationFrame(() => {
      if (selectedPull() == null) void select(first);
    });
    return;
  }
  if (!lastFetchedAt.has(state.kind) && state.pulls.length === 0) return;
  if (pulls.length === 0 && state.pulls.length > 0 && isAwaitingMergeStates()) {
    dom.pr.hidden = true;
    dom.empty.hidden = false;
    if (!dom.empty.classList.contains('is-loading')) {
      dom.empty.classList.add('is-loading');
      dom.empty.innerHTML = `<div class="boot-skeleton" aria-busy="true">${bootSkeleton()}</div>`;
    }
    return;
  }
  clearBootSkeletons();
  dom.pr.hidden = true;
  dom.empty.hidden = false;
  dom.empty.textContent = state.pulls.length === 0 ? 'No pull requests here.' : pulls.length === 0 ? 'No matches.' : 'Select a pull request';
}

function mergeState(pull: PullRequest): { label: string; tone: string } {
  if (pull.queueEntry != null) return { label: pull.queueEntry.state === 'UNMERGEABLE' ? 'Queue failed' : `In merge queue #${pull.queueEntry.position + 1}`, tone: pull.queueEntry.state === 'UNMERGEABLE' ? 'bad' : 'wait' };
  if (pull.isDraft) return { label: 'Draft', tone: 'muted' };
  if (pull.mergeable === 'CONFLICTING') return { label: 'Conflicts', tone: 'bad' };
  switch (pull.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { label: 'Ready', tone: 'ok' };
    case 'UNSTABLE':
      return { label: 'Checks failing', tone: 'bad' };
    case 'BLOCKED':
      return { label: 'Blocked', tone: 'bad' };
    case 'BEHIND':
      return { label: 'Behind base', tone: 'wait' };
    default:
      return { label: 'Checking…', tone: 'muted' };
  }
}

function reviewLabel(pull: PullRequest): { label: string; tone: string } {
  switch (pull.reviewDecision) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'ok' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', tone: 'bad' };
    case 'REVIEW_REQUIRED':
      return { label: 'Review required', tone: 'wait' };
    case null:
      return { label: 'Not approved', tone: 'wait' };
    default:
      return pull.reviewDecision satisfies never;
  }
}

function checksLabel(pull: PullRequest): { label: string; tone: string } {
  if (pull.failingRequired != null && (pull.checkState === 'FAILURE' || pull.checkState === 'ERROR')) {
    return pull.failingRequired.length > 0 ? { label: `Required failing (${pull.failingRequired.join(', ')})`, tone: 'bad' } : { label: 'Required passing', tone: 'ok' };
  }
  switch (pull.checkState) {
    case 'SUCCESS':
      return { label: 'Passing', tone: 'ok' };
    case 'FAILURE':
    case 'ERROR':
      return { label: 'Failing', tone: 'bad' };
    case 'PENDING':
    case 'EXPECTED':
      return { label: 'Running', tone: 'wait' };
    case null:
      return { label: 'Not approved', tone: 'wait' };
    default:
      return pull.checkState satisfies never;
  }
}



function skeletonLine(width: string, extra = ''): string {
  return `<span class="sk-line ${extra}" style="width:${width}"></span>`;
}

function conversationSkeleton(): string {
  return `<div class="skeleton">${[0, 1].map(() => `<div class="sk-comment"><span class="sk-avatar"></span><div class="sk-comment-body">${skeletonLine('28%')}${skeletonLine('92%')}${skeletonLine('70%')}</div></div>`).join('')}</div>`;
}

const REVIEW_LABELS: Record<string, { label: string; tone: string }> = {
  APPROVED: { label: 'approved', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'requested changes', tone: 'bad' },
  COMMENTED: { label: 'reviewed', tone: 'muted' },
  DISMISSED: { label: 'review dismissed', tone: 'muted' },
};

let showBotComments = localStorage.getItem('showBotComments') !== '0';

function conversationItemHtml(item: ConversationItem): string {
  const review = item.reviewState == null ? null : REVIEW_LABELS[item.reviewState] ?? { label: item.reviewState.toLowerCase(), tone: 'muted' };
  const avatarHtml = item.avatarUrl == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(item.avatarUrl)}&s=48" alt="" decoding="async" />`;
  const action = review == null ? 'commented' : `<span class="review-state tone-${review.tone}">${review.label}</span>`;
  const inline = item.inlineCount > 0 ? `<span class="muted">· ${item.inlineCount} inline comment${item.inlineCount === 1 ? '' : 's'}</span>` : '';
  const body = item.html.trim() === '' ? '' : `<div class="markdown comment-body">${sanitizeHtml(item.html)}</div>`;
  return `<article class="comment${item.isBot ? ' is-bot' : ''}${review != null ? ` review tone-${review.tone}` : ''}">
    <header>${avatarHtml}<b>${escapeHtml(item.author)}</b>${item.isBot ? '<span class="bot-tag">bot</span>' : ''}${action}${inline}<a class="comment-time" href="${escapeHtml(item.url)}" title="Open on GitHub">${relativeTime(item.at)} ago</a></header>
    ${body}
  </article>`;
}

let showResolvedThreads = false;
let currentThreads: ReviewThread[] = [];

function threadHtml(thread: ReviewThread): string {
  const location = `${thread.path}${thread.line != null ? `:${thread.line}` : ''}`;
  const [first, ...rest] = thread.comments;
  const commentHtml = (comment: ReviewThread['comments'][number], isReply: boolean): string => `<div class="thread-comment${isReply ? ' is-reply' : ''}">
      <header>${comment.avatarUrl == null ? '<span class="avatar"></span>' : `<img class="avatar" src="${escapeHtml(comment.avatarUrl)}&s=40" alt="" decoding="async" />`}<b>${escapeHtml(comment.author)}</b>${comment.isBot ? '<span class="bot-tag">bot</span>' : ''}<a class="comment-time" href="${escapeHtml(comment.url)}" title="Open on GitHub">${relativeTime(comment.at)} ago</a></header>
      <div class="markdown comment-body">${sanitizeHtml(comment.html)}</div>
    </div>`;
  const resolveLabel = thread.isResolved ? 'Unresolve' : 'Resolve';
  return `<article class="thread${thread.isResolved ? ' is-resolved' : ''}${thread.isOutdated ? ' is-outdated' : ''}" data-thread="${escapeHtml(thread.id)}">
    <header class="thread-head">
      <button type="button" class="thread-loc" data-thread-jump="${escapeHtml(thread.id)}" title="Show in diff">${icon('preview')}<code>${escapeHtml(location)}</code></button>
      ${thread.isOutdated ? '<span class="thread-tag">outdated</span>' : ''}
      ${thread.isResolved ? '<span class="thread-tag ok">resolved</span>' : ''}
      <span class="thread-actions">
        <button type="button" class="ghost thread-reply-open" data-thread-reply="${escapeHtml(thread.id)}" title="Reply">${icon('comment')}Reply</button>
        ${thread.canResolve ? `<button type="button" class="ghost thread-resolve" data-thread-resolve="${escapeHtml(thread.id)}" data-resolved="${thread.isResolved ? '1' : '0'}" title="${resolveLabel} thread">${icon(thread.isResolved ? 'refresh' : 'check')}${resolveLabel}</button>` : ''}
      </span>
    </header>
    ${first == null ? '' : commentHtml(first, false)}
    ${rest.map((comment) => commentHtml(comment, true)).join('')}
    ${thread.totalComments > thread.comments.length ? `<div class="thread-more muted">${thread.totalComments - thread.comments.length} more on GitHub</div>` : ''}
    <form class="thread-reply" data-thread-form="${escapeHtml(thread.id)}" hidden>
      <textarea rows="3" placeholder="Reply… (⌘↵ to send${thread.canResolve && !thread.isResolved ? ', ⌘⇧↵ to send and resolve' : ''})"></textarea>
      <div class="thread-reply-actions">
        <button type="button" class="ghost" data-thread-cancel>Cancel <kbd>esc</kbd></button>
        ${thread.canResolve && !thread.isResolved ? '<button type="button" class="ghost" data-thread-send-resolve>Reply &amp; resolve</button>' : ''}
        <button type="button" class="primary" data-thread-send>Reply <kbd>⌘</kbd><kbd>↵</kbd></button>
      </div>
    </form>
  </article>`;
}

function syncThreadsButton(open: number | null): void {
  const button = document.getElementById('threads-button') as HTMLButtonElement | null;
  const badge = button?.querySelector<HTMLElement>('.threads-badge');
  if (button == null || badge == null) return;
  button.disabled = open == null || open === 0 && currentThreads.length === 0;
  badge.hidden = open == null || open === 0;
  badge.textContent = String(open ?? 0);
  button.dataset.tip = open == null ? 'Loading review threads…' : open === 0 ? (currentThreads.length === 0 ? 'No review threads on this PR' : 'All review threads resolved  ⇧C') : `${open} open review thread${open === 1 ? '' : 's'}  ⇧C`;
}

function renderThreads(section: HTMLElement, threads: ReviewThread[]): void {
  currentThreads = threads;
  syncThreadsButton(threads.filter((thread) => !thread.isResolved).length);
  const open = threads.filter((thread) => !thread.isResolved);
  const resolved = threads.length - open.length;
  section.hidden = threads.length === 0;
  if (threads.length === 0) return;
  const shown = showResolvedThreads ? threads : open;
  section.innerHTML = `<div class="conversation-head"><span>${open.length === 0 ? 'Review threads' : `Open threads <span class="thread-count">${open.length}</span>`}</span>${resolved > 0 ? `<button type="button" class="link-button" data-toggle-resolved>${showResolvedThreads ? 'Hide' : 'Show'} ${resolved} resolved</button>` : ''}</div>
    <div class="thread-list">${shown.length === 0 ? '<p class="muted thread-empty">All threads resolved.</p>' : shown.map(threadHtml).join('')}</div>`;
  clampLongComments(section);
}

async function refreshThreads(pull: PullRequest, description: HTMLElement, token: number, isFresh = false): Promise<void> {
  const section = description.querySelector<HTMLElement>('[data-threads]');
  if (section == null) return;
  try {
    const threads = await loadThreads(pull, isFresh);
    if (token !== renderToken) return;
    renderThreads(section, threads);
    const open = threads.filter((thread) => !thread.isResolved).length;
    if (pull.openThreads !== open) {
      pull.openThreads = open;
      invalidateList();
      renderList();
    }
  } catch (error) {
    if (token !== renderToken) return;
    section.hidden = false;
    section.innerHTML = `<p class="error">Could not load review threads: ${escapeHtml(errorMessage(error))}</p>`;
  }
}

async function toggleThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  const pull = selectedPull();
  const section = dom.descPane.querySelector<HTMLElement>('[data-threads]');
  if (pull == null || section == null) return;
  const thread = currentThreads.find((candidate) => candidate.id === threadId);
  if (thread == null) return;
  const previous = thread.isResolved;
  thread.isResolved = resolved;
  renderThreads(section, currentThreads);
  pull.openThreads = currentThreads.filter((candidate) => !candidate.isResolved).length;
  invalidateList();
  renderList();
  try {
    await setThreadResolved(threadId, resolved);
    forgetThreads(pull);
    toast(`${resolved ? 'Resolved' : 'Reopened'} thread on ${thread.path} · #${pull.number}`);
  } catch (error) {
    thread.isResolved = previous;
    renderThreads(section, currentThreads);
    pull.openThreads = currentThreads.filter((candidate) => !candidate.isResolved).length;
    invalidateList();
    renderList();
    toast(`Updating thread on ${thread.path} · #${pull.number} failed: ${errorMessage(error)}`, true);
  }
}

async function sendThreadReply(threadId: string, form: HTMLElement, alsoResolve: boolean): Promise<void> {
  const pull = selectedPull();
  const textarea = form.querySelector('textarea');
  const body = textarea?.value.trim() ?? '';
  if (pull == null || textarea == null || body === '') return;
  form.querySelectorAll('button').forEach((button) => (button.disabled = true));
  try {
    await replyToThread(threadId, body);
    if (alsoResolve) await setThreadResolved(threadId, true);
    toast(`${alsoResolve ? 'Replied and resolved' : 'Replied'} on #${pull.number}`);
    await refreshThreads(pull, dom.descPane, renderToken, true);
  } catch (error) {
    form.querySelectorAll('button').forEach((button) => (button.disabled = false));
    toast(`Reply on #${pull.number} failed: ${errorMessage(error)}`, true);
  }
}

function jumpToThread(threadId: string): void {
  const thread = currentThreads.find((candidate) => candidate.id === threadId);
  const file = currentFiles.find((candidate) => candidate.diff.name === thread?.path);
  if (thread == null || file == null) {
    toast(`${thread?.path ?? 'That file'} is not in the current diff`, true);
    return;
  }
  if (thread.line != null) diffView.scrollToLine(file.id, thread.line, 'additions');
  else diffView.scrollToFile(file.id);
}

function focusFirstOpenThread(): void {
  const section = dom.descPane.querySelector<HTMLElement>('[data-threads]');
  const first = section?.querySelector<HTMLElement>('.thread:not(.is-resolved)') ?? (currentThreads.length > 0 ? section?.querySelector<HTMLElement>('.conversation-head') : null);
  if (section == null || first == null) {
    toast(`No review threads on #${selectedPull()?.number ?? ""}`);
    return;
  }
  glideScrollTo(dom.descPane, dom.descPane.scrollTop + first.getBoundingClientRect().top - dom.descPane.getBoundingClientRect().top - 12);
  flash(first);
}

dom.descPane.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const resolve = target.closest<HTMLElement>('[data-thread-resolve]');
  if (resolve != null) return void toggleThreadResolved(resolve.dataset.threadResolve ?? '', resolve.dataset.resolved !== '1');
  const jump = target.closest<HTMLElement>('[data-thread-jump]');
  if (jump != null) return jumpToThread(jump.dataset.threadJump ?? '');
  if (target.closest('[data-toggle-resolved]') != null) {
    showResolvedThreads = !showResolvedThreads;
    const section = dom.descPane.querySelector<HTMLElement>('[data-threads]');
    if (section != null) renderThreads(section, currentThreads);
    return;
  }
  const replyOpen = target.closest<HTMLElement>('[data-thread-reply]');
  if (replyOpen != null) {
    const form = dom.descPane.querySelector<HTMLElement>(`[data-thread-form="${CSS.escape(replyOpen.dataset.threadReply ?? '')}"]`);
    if (form != null) {
      form.hidden = false;
      form.querySelector('textarea')?.focus();
    }
    return;
  }
  const form = target.closest<HTMLElement>('[data-thread-form]');
  if (form == null) return;
  if (target.closest('[data-thread-cancel]') != null) form.hidden = true;
  else if (target.closest('[data-thread-send-resolve]') != null) void sendThreadReply(form.dataset.threadForm ?? '', form, true);
  else if (target.closest('[data-thread-send]') != null) void sendThreadReply(form.dataset.threadForm ?? '', form, false);
});

dom.descPane.addEventListener('keydown', (event) => {
  const form = (event.target as HTMLElement).closest<HTMLElement>('[data-thread-form]');
  if (form == null) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    form.hidden = true;
    return;
  }
  if (event.key === 'Enter' && event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    void sendThreadReply(form.dataset.threadForm ?? '', form, event.shiftKey);
  }
});

function renderConversation(container: Element, items: ConversationItem[]): void {
  const visible = showBotComments ? items : items.filter((item) => !item.isBot);
  const botCount = items.filter((item) => item.isBot).length;
  const count = container.querySelector('.conversation-count');
  if (count != null) count.innerHTML = `${items.length} · <button class="link-button" data-toggle-bots>${showBotComments ? 'Hide' : 'Show'} ${botCount} bot${botCount === 1 ? '' : 's'}</button>`;
  const list = container.querySelector('.conversation-list');
  if (list == null) return;
  const signature = visible.map((item) => `${item.id}:${item.html.length}:${item.reviewState ?? ''}`).join('|');
  if (list.getAttribute('data-signature') === signature) return;
  const isFirstRender = !list.hasAttribute('data-signature');
  list.setAttribute('data-signature', signature);
  if (visible.length === 0) list.innerHTML = `<p class="muted">${items.length === 0 ? 'No comments yet.' : 'Only bot comments · hidden.'}</p>`;
  else {
    const existing = new Map([...list.querySelectorAll<HTMLElement>('[data-comment-id]')].map((node) => [node.dataset.commentId ?? '', node]));
    const nodes = visible.map((item) => {
      const kept = existing.get(item.id);
      if (kept != null && kept.dataset.commentSize === String(item.html.length)) return kept;
      const holder = document.createElement('div');
      holder.innerHTML = conversationItemHtml(item);
      const node = holder.firstElementChild as HTMLElement;
      adoptImages(existing.values(), [node]);
      node.dataset.commentId = item.id;
      node.dataset.commentSize = String(item.html.length);
      return node;
    });
    list.replaceChildren(...nodes);
  }
  if (isFirstRender) list.classList.add('fade-in');
  preloadImages(imageUrlsInHtml(visible.map((item) => item.html).join('')));
  clampLongComments(list);
}

const COMMENT_CLAMP_PX = 320;

function clampLongComments(list: Element): void {
  requestAnimationFrame(() => {
    list.querySelectorAll<HTMLElement>('.comment-body').forEach((body) => {
      if (body.scrollHeight <= COMMENT_CLAMP_PX + 40 || body.nextElementSibling?.classList.contains('comment-more')) return;
      body.classList.add('is-clamped');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'comment-more';
      more.textContent = 'Show more';
      more.addEventListener('click', () => {
        const isClamped = body.classList.toggle('is-clamped');
        more.textContent = isClamped ? 'Show more' : 'Show less';
        if (isClamped) body.closest('.comment')?.scrollIntoView({ block: 'nearest' });
      });
      body.after(more);
    });
  });
}

function listSkeleton(): string {
  const titles = [72, 58, 81, 64, 49, 77, 60, 69, 54, 74, 62, 57, 79, 51];
  return titles.map((width, index) => `<div class="sk-row" style="--delay:${index * 40}ms"><span class="sk-dot"></span><span class="sk-line sk-id"></span><span class="sk-line" style="width:${width}%"></span><span class="sk-line sk-age"></span></div>`).join('');
}

function bootSkeleton(): string {
  return `<div class="boot-head"><span class="sk-line" style="width:180px"></span><span class="sk-dot"></span></div>
    <div class="boot-split"><div class="boot-desc">${descriptionSkeleton()}</div><div class="boot-diff">${diffSkeleton()}</div></div>`;
}

function renderBootSkeletons(): void {
  const list = document.getElementById('list-skeleton');
  if (list != null && state.pulls.length === 0) list.innerHTML = listSkeleton();
  const boot = dom.empty.querySelector('.boot-skeleton');
  if (boot != null) boot.innerHTML = bootSkeleton();
}

function clearBootSkeletons(): void {
  document.getElementById('list-skeleton')?.remove();
  dom.empty.classList.remove('is-loading');
}

function descriptionSkeleton(): string {
  return `<div class="skeleton" aria-label="Loading description" aria-busy="true">
    ${skeletonLine('22%', 'sk-heading')}
    ${skeletonLine('96%')}${skeletonLine('88%')}${skeletonLine('64%')}
    ${skeletonLine('30%', 'sk-heading')}
    ${skeletonLine('92%')}${skeletonLine('81%')}${skeletonLine('86%')}${skeletonLine('48%')}
    <span class="sk-block"></span>
  </div>`;
}

function filesSkeleton(): string {
  const widths = ['62%', '48%', '74%', '55%', '68%', '40%'];
  return `<div class="skeleton files-skeleton" aria-busy="true">${widths.map((width) => `<div class="sk-file"><span class="sk-line" style="width:${width}"></span><span class="sk-line sk-count"></span></div>`).join('')}</div>`;
}

function diffSkeleton(): string {
  const cards = [9, 6, 11].map((lines, card) => `<div class="sk-diff-card">
      <div class="sk-diff-head"><span class="sk-dot"></span><span class="sk-line" style="width:${[44, 58, 36][card]}%"></span></div>
      ${Array.from({ length: lines }, (_, line) => `<div class="sk-diff-row"><span class="sk-gutter"></span><span class="sk-line${line % 4 === 1 ? ' sk-add' : line % 5 === 3 ? ' sk-del' : ''}" style="width:${35 + ((line * 37 + card * 13) % 55)}%"></span></div>`).join('')}
    </div>`);
  return `<div class="skeleton diff-skeleton" aria-busy="true">${cards.join('')}</div>`;
}

function showDiffLoading(isLoading: boolean): void {
  let overlay = document.getElementById('diff-loading');
  if (!isLoading) {
    overlay?.classList.add('done');
    window.setTimeout(() => overlay?.remove(), 180);
    return;
  }
  if (overlay == null) {
    overlay = document.createElement('div');
    overlay.id = 'diff-loading';
    dom.diffRoot.parentElement?.insertBefore(overlay, dom.diffRoot);
  }
  overlay.classList.remove('done');
  overlay.innerHTML = diffSkeleton();
}

function descriptionHtml(bodyHtml: string): string {
  return bodyHtml.trim() === '' ? '<p class="muted">No description provided.</p>' : sanitizeHtml(bodyHtml);
}

function renderDescription(pull: PullRequest): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = 'description';
  const body = descriptionSkeleton();
  wrapper.innerHTML = `
    <h1>${escapeHtml(pull.title)}</h1>
    <div class="byline">${avatar(pull)}<b>${escapeHtml(pull.author?.login ?? 'ghost')}</b> opened ${relativeTime(pull.createdAt)} ago · <code>${escapeHtml(pull.headRefName)}</code> → <code>${escapeHtml(pull.baseRefName)}</code></div>
    <div class="markdown">${body}</div>
    <section class="threads" data-threads hidden></section>
    <section class="conversation" data-conversation><div class="conversation-head"><span>Conversation</span><span class="muted conversation-count"></span></div><div class="conversation-list">${conversationSkeleton()}</div></section>
    <div class="files-divider"><span>${pull.changedFiles} files changed</span><span><i class="add">+${pull.additions}</i> <i class="del">−${pull.deletions}</i></span></div>`;
  return wrapper;
}


const DEVIN_LOGO = '<svg class="devin-logo" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5.9 1.6 8.3 3v2.8L5.9 7.2 3.5 5.8V3zM11.1 4.6l2.4 1.4v2.8l-2.4 1.4-2.4-1.4V6zM5.9 8.8l2.4 1.4V13l-2.4 1.4L3.5 13v-2.8z"/><path d="M8.2 5.7 8.9 6.2M8.2 10.3 8.9 9.8" stroke="currentColor" stroke-width="1.2"/></svg>';
const BULK_FIX_MESSAGE = 'Fix CI and merge conflicts if any';

function devinFixMessage(pull: PullRequest): string | null {
  const conflicted = isConflicted(pull);
  const failing = isFailing(pull);
  if (conflicted && failing) return 'Fix CI and merge conflicts';
  if (conflicted) return 'Fix merge conflicts';
  if (failing) return 'Fix CI';
  return null;
}

function fixButton(pull: PullRequest): string {
  const message = devinFixMessage(pull);
  if (message == null) return '';
  const disabled = fixingWithDevin.has(pull.id) ? ' disabled' : '';
  return `<button type="button" class="fix-conflicts" id="fix-with-devin" title="Send “${message}” to the linked Devin session  ⇧F"${disabled}>${DEVIN_LOGO}<span>Fix with Devin</span><kbd>⇧</kbd><kbd>F</kbd></button>`;
}

function chip(content: string, title: string, className = ''): string {
  return `<span class="chip-meta ${className}" title="${escapeHtml(title)}">${content}</span>`;
}

function renderDetailMeta(pull: PullRequest): void {
  const checks = checksLabel(pull);
  const review = reviewLabel(pull);
  const merge = mergeState(pull);
  const summary = [merge.label, review.tone === 'muted' ? '' : review.label, checks.tone === 'muted' ? '' : `Checks ${checks.label.toLowerCase()}`].filter((part) => part !== '').join(' · ');
  dom.statusBar.innerHTML = [
    chip(`${avatar(pull)}${escapeHtml(pull.author?.login ?? 'ghost')}`, 'Author', 'plain'),
    chip(`<code>${escapeHtml(pull.headRefName)}</code><span class="arrow">→</span><code>${escapeHtml(pull.baseRefName)}</code>`, `${pull.headRefName} → ${pull.baseRefName}`, 'plain branch'),
    isConflicted(pull) ? chip(`${icon('conflict')}Merge conflicts`, `${pull.headRefName} conflicts with ${pull.baseRefName}: rebase or merge ${pull.baseRefName} to fix`, 'conflicts tone-bad') : '',
    isFailing(pull) ? chip(`${icon('x')}Required checks failing`, `Failing required checks: ${(pull.failingRequired ?? []).join(', ') || 'see GitHub'}`, 'conflicts tone-bad') : '',
    fixButton(pull),
    `<span class="status-summary" title="${escapeHtml(summary)}">${statusIcon(pull)}</span>`,
  ].join('');
  dom.merge.disabled = pull.isDraft || pull.mergeable === 'CONFLICTING' || pull.queueEntry != null || leaving.has(pull.id);
  const isOwn = isOwnPull(pull);
  dom.approve.disabled = isOwn;
  dom.approve.title = isOwn ? 'You can’t approve your own pull request' : 'Approve  A';
  if (pull.queueEntry != null) {
    dom.merge.innerHTML = `${MERGE_ICON}<span class="merge-count">#${pull.queueEntry.position + 1}</span>`;
    dom.merge.title = `In merge queue #${pull.queueEntry.position + 1}`;
  }
}

function syncQueueState(pull: PullRequest): void {
  isSelectedQueued = false;
  syncMergeLabel();
  void usesMergeQueue(pull).then((isQueued) => {
    if (selectedPull()?.id !== pull.id) return;
    isSelectedQueued = isQueued;
    syncMergeLabel();
  });
}

let lastDescription: { pullId: string; element: HTMLElement } | null = null;

function renderDetail(pull: PullRequest): void {
  syncQueueState(pull);
  currentThreads = [];
  syncThreadsButton(null);
  void syncDevinButton(pull);
  void syncPreviewButton(pull);
  dom.crumbs.innerHTML = `<span class="repo" title="${escapeHtml(pull.repository.nameWithOwner)}">${escapeHtml(repoName(pull))}</span><span class="sep">›</span><a class="cur pr-link" href="${escapeHtml(pull.url)}" title="Open on GitHub  O">#${pull.number}</a>`;
  renderDetailMeta(pull);
  const description = renderDescription(pull);
  const previousDescription = lastDescription?.pullId === pull.id ? lastDescription.element : null;
  lastDescription = { pullId: pull.id, element: description };
  if (reviewMode === 'side') {
    dom.descPane.replaceChildren(description);
    diffView.setHeader(undefined);
  } else {
    dom.descPane.replaceChildren();
    diffView.setHeader(description);
  }
  const token = renderToken;
  void loadConversation(pull).then(
    (items) => {
      if (token !== renderToken) return;
      const section = description.querySelector('[data-conversation]');
      if (section == null) return;
      renderConversation(section, items);
      const previousList = previousDescription?.querySelector('.conversation-list');
      const list = section.querySelector('.conversation-list');
      if (previousList != null && list != null) {
        adoptImages([previousList], [list]);
        list.classList.remove('fade-in');
      }
      void refreshThreads(pull, description, token);
      section.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('[data-toggle-bots]') == null) return;
        showBotComments = !showBotComments;
        localStorage.setItem('showBotComments', showBotComments ? '1' : '0');
        renderConversation(section, items);
      });
    },
    (error: unknown) => {
      if (token !== renderToken) return;
      const list = description.querySelector('.conversation-list');
      if (list != null) list.innerHTML = `<p class="error">Could not load comments: ${escapeHtml(errorMessage(error))}</p>`;
    },
  );
  void loadBody(pull, true).then(
    (bodyHtml) => {
      if (token !== renderToken) return;
      const target = description.querySelector('.markdown');
      if (target != null) {
        const html = descriptionHtml(bodyHtml);
        target.innerHTML = html;
        target.setAttribute('data-body', html);
        const previousBody = previousDescription?.querySelector('.markdown');
        if (previousBody?.getAttribute('data-body') === html) adoptImages([previousBody], [target]);
        else target.classList.add('fade-in');
      }
    },
    (error: unknown) => {
      if (token !== renderToken) return;
      const target = description.querySelector('.markdown');
      if (target != null) target.innerHTML = `<p class="error">Could not load description: ${escapeHtml(errorMessage(error))}</p>`;
    },
  );
}

function fileLabel(file: ParsedFile): string {
  const slash = file.diff.name.lastIndexOf('/');
  const directory = slash >= 0 ? file.diff.name.slice(0, slash + 1) : '';
  return `<span class="base">${escapeHtml(file.diff.name.slice(slash + 1))}</span><span class="dir">${escapeHtml(directory)}</span>`;
}

function renderFiles(files: ParsedFile[]): void {
  dom.fileCount.textContent = String(files.length);
  dom.files.innerHTML = files
    .map(
      (file, index) => `<button data-index="${index}" data-id="${escapeHtml(file.id)}" class="file ${file.diff.type}${diffView.isCollapsed(file.id) ? ' collapsed' : ''}" title="${escapeHtml(file.diff.name)}">
        <span class="name">${fileLabel(file)}</span><span class="counts"><i class="add">+${file.additions}</i><i class="del">−${file.deletions}</i></span>
      </button>`,
    )
    .join('');
}

function markFileCollapsed(id: string, isCollapsed: boolean): void {
  dom.files.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('collapsed', isCollapsed);
}

function setActiveFile(index: number): void {
  const file = currentFiles[index];
  if (file == null) return;
  state.activeFileIndex = index;
  dom.files.querySelector('.active')?.classList.remove('active');
  const button = dom.files.querySelector<HTMLElement>(`[data-index="${index}"]`);
  button?.classList.add('active');
  button?.scrollIntoView({ block: 'nearest' });
  if (diffView.isCollapsed(file.id)) diffView.toggle(file.id, false);
  diffView.scrollToFile(file.id);
}

function prefetchAround(pull: PullRequest): void {
  const pulls = visiblePulls();
  const index = pulls.findIndex((candidate) => candidate.id === pull.id);
  const neighbours = [...pulls.slice(index + 1, index + 1 + PREFETCH_AHEAD), ...(index > 0 ? [pulls[index - 1]] : [])];
  const run = (): void =>
    neighbours.forEach((candidate) => {
      if (candidate == null || state.selectedId !== pull.id) return;
      void loadDiff(candidate).catch(() => undefined);
      void loadBody(candidate).catch(() => undefined);
    });
  const idle = (window as unknown as { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle != null) idle(run, { timeout: 300 });
  else window.setTimeout(run, 120);
}

let detailFrame = 0;
let lastSelectAt = 0;
const RAPID_SELECT_MS = 90;

function select(pull: PullRequest): Promise<void> {
  const previousId = state.selectedId;
  state.selectedId = pull.id;
  if (previousId != null && previousId !== pull.id && leaving.has(previousId)) scheduleLeave(previousId);
  state.activeFileIndex = -1;
  virtualList.scrollToKey(pull.id);
  virtualList.highlightKey(pull.id);
  virtualList.forEachRendered((element) => {
    const isSelected = element.dataset.key === pull.id;
    if (element.classList.contains('selected') !== isSelected) element.classList.toggle('selected', isSelected);
  });
  const now = performance.now();
  const isRapid = now - lastSelectAt < RAPID_SELECT_MS;
  lastSelectAt = now;
  cancelAnimationFrame(detailFrame);
  window.clearTimeout(detailFrame);
  if (!isRapid) return renderSelection(pull);
  return new Promise((resolve) => {
    detailFrame = window.setTimeout(() => {
      if (state.selectedId === pull.id) void renderSelection(pull).then(resolve);
      else resolve();
    }, RAPID_SELECT_MS);
  });
}

let lastRenderedPullId: string | null = null;

function resetScrollForNewPull(pull: PullRequest): void {
  if (lastRenderedPullId === pull.id) return;
  lastRenderedPullId = pull.id;
  dom.descPane.scrollTop = 0;
  diffView.resetScroll();
  dom.files.scrollTop = 0;
}

async function renderSelection(pull: PullRequest): Promise<void> {
  const token = ++renderToken;
  if (!element('find-bar').hidden) closeFind();
  resetScrollForNewPull(pull);
  dom.empty.hidden = true;
  dom.pr.hidden = false;
  currentFiles = [];
  diffView.show([]);
  renderDetail(pull);
  const diffPromise = loadDiff(pull);
  let isSettled = false;
  void diffPromise.finally(() => (isSettled = true)).catch(() => undefined);
  const skeletonTimer = window.setTimeout(() => {
    if (isSettled || token !== renderToken) return;
    dom.files.innerHTML = filesSkeleton();
    dom.fileCount.textContent = '';
    showDiffLoading(true);
  }, 60);
  prefetchAround(pull);
  try {
    const files = await diffPromise;
    if (token !== renderToken) return;
    currentFiles = files;
    diffView.show(files);
    renderFiles(files);
  } catch (error) {
    if (token !== renderToken) return;
    dom.files.innerHTML = `<div class="error pad">${escapeHtml(errorMessage(error))}</div>`;
  } finally {
    window.clearTimeout(skeletonTimer);
    if (token === renderToken) showDiffLoading(false);
  }
}

function movePull(delta: number): void {
  const pulls = visiblePulls();
  if (pulls.length === 0) return;
  const index = pulls.findIndex((pull) => pull.id === state.selectedId);
  const next = pulls[Math.min(pulls.length - 1, Math.max(0, index + delta))];
  if (next != null && next.id !== state.selectedId) void select(next);
  if (next != null && visualAnchorId != null) {
    state.selectedId = next.id;
    syncVisualRange();
  }
}

const LIST_PAGE_ROWS = 10;
const DIFF_LINE_PX = 60;

function listPageSize(): number {
  return Math.max(1, Math.floor(dom.list.clientHeight / ROW_HEIGHT / 2)) || LIST_PAGE_ROWS;
}

function jumpPull(position: 'first' | 'last'): void {
  const pulls = visiblePulls();
  const target = position === 'first' ? pulls[0] : pulls.at(-1);
  if (target != null && target.id !== state.selectedId) void select(target);
}

type PaneTarget = 'list' | 'middle' | 'right';
type VimMotion = 'half-down' | 'half-up' | 'page-down' | 'page-up' | 'line-down' | 'line-up' | 'top' | 'bottom';

const PANE_MODIFIER: Record<PaneTarget, string> = { list: '⌃', middle: '⌥', right: '⌘' };
const PANE_LABEL: Record<PaneTarget, string> = { list: 'list', middle: 'middle pane', right: 'right pane' };
const MOTION_KEYS: Record<VimMotion, string> = { 'half-down': 'd', 'half-up': 'u', 'page-down': 'f', 'page-up': 'b', 'line-down': 'e', 'line-up': 'y', top: 'g', bottom: '⇧g' };
const MOTION_TITLE: Record<VimMotion, string> = { 'half-down': 'Half page down', 'half-up': 'Half page up', 'page-down': 'Page down', 'page-up': 'Page up', 'line-down': 'Scroll down', 'line-up': 'Scroll up', top: 'Top', bottom: 'Bottom' };
const SKIPPED_MOTIONS: Partial<Record<PaneTarget, VimMotion[]>> = { right: ['page-down', 'page-up'] };
const EXTRA_MOTION_KEYS: Partial<Record<PaneTarget, Partial<Record<VimMotion, string[]>>>> = {
  list: { 'line-down': ['⌃n'], 'line-up': ['⌃p'] },
  middle: { 'line-down': ['⌥j'], 'line-up': ['⌥k'] },
};

function paneElement(pane: Exclude<PaneTarget, 'list'>): HTMLElement {
  if (reviewMode === 'side') return pane === 'middle' ? dom.descPane : dom.diffRoot;
  return pane === 'middle' ? dom.diffRoot : dom.files;
}

function scrollPane(pane: Exclude<PaneTarget, 'list'>, motion: VimMotion): void {
  const target = paneElement(pane);
  const page = target.clientHeight;
  const deltas: Record<VimMotion, number> = {
    'half-down': page * 0.5, 'half-up': -page * 0.5, 'page-down': page * 0.9, 'page-up': -page * 0.9,
    'line-down': DIFF_LINE_PX, 'line-up': -DIFF_LINE_PX, top: -target.scrollHeight, bottom: target.scrollHeight,
  };
  const isStep = motion === 'line-down' || motion === 'line-up';
  if (isStep) {
    if (target === dom.diffRoot) diffView.stepBy(deltas[motion]);
    else glideScrollBy(target, deltas[motion]);
    return;
  }
  if (target === dom.diffRoot) diffView.glideBy(deltas[motion]);
  else glideScrollTo(target, target.scrollTop + deltas[motion]);
}

function moveList(motion: VimMotion): void {
  const half = listPageSize();
  const steps: Record<VimMotion, number> = { 'half-down': half, 'half-up': -half, 'page-down': half * 2, 'page-up': -half * 2, 'line-down': 1, 'line-up': -1, top: -Infinity, bottom: Infinity };
  const step = steps[motion];
  if (step === -Infinity) return jumpPull('first');
  if (step === Infinity) return jumpPull('last');
  movePull(step);
}

function vimCommands(): Command[] {
  const panes: PaneTarget[] = ['list', 'middle', 'right'];
  const motions = Object.keys(MOTION_KEYS) as VimMotion[];
  return panes.flatMap((pane) =>
    motions.filter((motion) => !(SKIPPED_MOTIONS[pane] ?? []).includes(motion)).map((motion): Command => ({
      id: `vim-${pane}-${motion}`,
      section: `Vim · ${PANE_LABEL[pane]} (${PANE_MODIFIER[pane]})`,
      title: `${MOTION_TITLE[motion]} in ${PANE_LABEL[pane]}`,
      aliases: 'vim scroll',
      keys: [`${PANE_MODIFIER[pane]}${MOTION_KEYS[motion]}`, ...(EXTRA_MOTION_KEYS[pane]?.[motion] ?? [])],
      run: () => (pane === 'list' ? moveList(motion) : scrollPane(pane, motion)),
      isEnabled: pane === 'list' ? undefined : hasPull,
    })),
  );
}

function moveFile(delta: number): void {
  if (currentFiles.length === 0) return;
  setActiveFile(Math.min(currentFiles.length - 1, Math.max(0, state.activeFileIndex + delta)));
}

function toggleCurrentFile(): void {
  const file = currentFiles[Math.max(0, state.activeFileIndex)];
  if (file != null) diffView.toggle(file.id);
}

const mergeStateCache = new Map<string, { updatedAt: string; fetchedAt: number; state: MergeState }>();
/** A PR's updatedAt does not change when its base branch moves, so conflicts can appear on an untouched PR; re-check after this long. */
const MERGE_STATE_MAX_AGE_MS = 3 * 60_000;

function cachedMergeState(pull: PullRequest): MergeState | null {
  const cached = mergeStateCache.get(pull.id);
  if (cached == null || cached.updatedAt !== pull.updatedAt || Date.now() - cached.fetchedAt > MERGE_STATE_MAX_AGE_MS) return null;
  return cached.state;
}

const AI_CONCURRENCY = 4;
const AI_CACHE_KEY = 'jevReadiness.v2';
const aiResults = new Map<string, ReadinessResult>(Object.entries(JSON.parse(localStorage.getItem(AI_CACHE_KEY) ?? '{}') as Record<string, ReadinessResult>));
const aiPending = new Set<string>();
let isAiEnabled = false;
let aiRenderFrame = 0;

function aiKey(pull: PullRequest): string {
  return `${pull.id}:${pull.updatedAt}`;
}

function aiScoreFor(pull: PullRequest): number | undefined {
  return isAiEnabled ? aiResults.get(aiKey(pull))?.score : undefined;
}

function persistAiResults(): void {
  const live = new Set(state.pulls.map(aiKey));
  const kept = Object.fromEntries([...aiResults.entries()].filter(([key]) => live.has(key)).slice(-400));
  localStorage.setItem(AI_CACHE_KEY, JSON.stringify(kept));
}

function scheduleAiRender(): void {
  cancelAnimationFrame(aiRenderFrame);
  aiRenderFrame = requestAnimationFrame(() => {
    const key = state.selectedId;
    if (key == null) renderList();
    else virtualList.preserveOffset(key, renderList);
    const pull = selectedPull();
    if (pull != null) renderDetailMeta(pull);
    renderAiStatus();
  });
}

function renderAiStatus(): void {
  const badge = document.getElementById('ai-status');
  if (badge == null) return;
  if (!isAiEnabled) {
    badge.textContent = 'Rules';
    badge.title = 'Built-in rules · set OPENROUTER_API_KEY for smart ranking';
    badge.className = 'ai-status off';
    return;
  }
  const scored = state.pulls.filter((pull) => aiResults.has(aiKey(pull))).length;
  badge.textContent = aiPending.size > 0 ? `AI ${scored}/${state.pulls.length}` : 'AI';
  badge.title = 'Smart sort ranks by AI readiness';
  badge.className = aiPending.size > 0 ? 'ai-status busy' : 'ai-status on';
}

async function scoreWithJev(pulls: PullRequest[]): Promise<void> {
  if (!isAiEnabled) return;
  const queue = pulls.filter((pull) => !pull.isDraft && !aiResults.has(aiKey(pull)) && !aiPending.has(aiKey(pull)));
  queue.forEach((pull) => aiPending.add(aiKey(pull)));
  renderAiStatus();
  const worker = async (): Promise<void> => {
    for (let pull = queue.shift(); pull != null; pull = queue.shift()) {
      const key = aiKey(pull);
      try {
        aiResults.set(key, await assessReadiness(pull));
        invalidateList();
        smartCountsSource = null;
      } catch (error) {
        console.warn('jev readiness failed', pull.number, errorMessage(error));
      } finally {
        aiPending.delete(key);
        scheduleAiRender();
      }
    }
  };
  await Promise.all(Array.from({ length: AI_CONCURRENCY }, worker));
  persistAiResults();
}
let mergeStateRenderFrame = 0;

function applyMergeStates(kind: QueueKind, states: MergeState[]): void {
  invalidateList();
  const byId = new Map(states.map((mergeState) => [mergeState.id, mergeState]));
  const pulls = queueCache.get(kind);
  if (pulls == null) return;
  const updated = pulls.map((pull) => {
    const mergeState = byId.get(pull.id);
    if (mergeState == null) return pull;
    if (mergeState.mergeStateStatus !== 'UNKNOWN') mergeStateCache.set(pull.id, { updatedAt: pull.updatedAt, fetchedAt: Date.now(), state: mergeState });
    return { ...pull, mergeable: mergeState.mergeable, mergeStateStatus: mergeState.mergeStateStatus, openThreads: mergeState.openThreads, failingRequired: mergeState.failingRequired, failingOptional: mergeState.failingOptional };
  });
  queueCache.set(kind, updated);
  if (kind !== state.kind) return;
  state.pulls = updated;
  cancelAnimationFrame(mergeStateRenderFrame);
  mergeStateRenderFrame = requestAnimationFrame(() => {
    renderList();
    if (selectedPull() == null) {
      const first = visiblePulls()[0];
      if (first != null) void select(first);
    }
    const pull = selectedPull();
    if (pull != null) renderDetailMeta(pull);
  });
}

const MERGE_STATE_RETRY_MS = [2_000, 5_000, 10_000, 20_000];

async function loadMergeStates(kind: QueueKind, pulls: PullRequest[]): Promise<void> {
  let pending = pulls.filter((pull) => cachedMergeState(pull) == null).map((pull) => pull.id);
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    const unknown: string[] = [];
    await fetchMergeStates(pending, (states) => {
      applyMergeStates(kind, states);
      unknown.push(...states.filter((mergeState) => mergeState.mergeStateStatus === 'UNKNOWN').map((mergeState) => mergeState.id));
    });
    const delay = MERGE_STATE_RETRY_MS[attempt];
    if (delay == null || unknown.length === 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    pending = unknown;
  }
}

const inFlight = new Map<QueueKind, Promise<void>>();
const lastFetchedAt = new Map<QueueKind, number>();
const MIN_REFRESH_GAP_MS = 20_000;

let refreshTicker: number | undefined;

function renderRefreshStatus(): void {
  const status = document.getElementById('refresh-status');
  const button = document.getElementById('refresh-button');
  const isLoading = inFlight.has(state.kind);
  button?.classList.toggle('spinning', isLoading);
  document.getElementById('list-pane')?.classList.toggle('loading', isLoading);
  status?.classList.toggle('active', isLoading);
  if (status == null) return;
  if (isLoading) {
    status.textContent = 'Refreshing…';
    return;
  }
  const at = lastFetchedAt.get(state.kind);
  if (at == null) {
    status.textContent = '';
    return;
  }
  const seconds = Math.round((Date.now() - at) / 1000);
  status.textContent = seconds < 10 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
  status.title = `Last refreshed ${new Date(at).toLocaleTimeString()}`;
}

function summarizeChange(before: PullRequest[], after: PullRequest[]): string {
  const beforeIds = new Set(before.map((pull) => pull.id));
  const afterIds = new Set(after.map((pull) => pull.id));
  const added = after.filter((pull) => !beforeIds.has(pull.id)).length;
  const removed = before.filter((pull) => !afterIds.has(pull.id)).length;
  const beforeById = new Map(before.map((pull) => [pull.id, pull]));
  const updated = after.filter((pull) => {
    const previous = beforeById.get(pull.id);
    return previous != null && previous.updatedAt !== pull.updatedAt;
  }).length;
  const parts = [added > 0 ? `${added} new` : '', removed > 0 ? `${removed} closed or merged` : '', updated > 0 ? `${updated} updated` : ''].filter((part) => part !== '');
  return parts.length === 0 ? `Up to date · ${after.length} PRs` : `Refreshed · ${parts.join(' · ')}`;
}

function manualRefresh(): void {
  stableOrder.reset();
  const before = queueCache.get(state.kind) ?? [];
  const kind = state.kind;
  const started = Date.now();
  if (inFlight.has(kind)) {
    toast('Already refreshing…');
    return;
  }
  toast('Refreshing pull requests…');
  const pending = refresh(kind, true);
  renderRefreshStatus();
  void pending.then(() => {
    if (kind !== state.kind || !lastFetchedAt.has(kind) || (lastFetchedAt.get(kind) ?? 0) < started) return;
    toast(summarizeChange(before, queueCache.get(kind) ?? []));
  });
}

function refresh(kind: QueueKind, isForced = false): Promise<void> {
  const running = inFlight.get(kind);
  if (running != null) return running;
  if (!isForced && Date.now() - (lastFetchedAt.get(kind) ?? 0) < MIN_REFRESH_GAP_MS) return Promise.resolve();
  const pending = fetchQueue(kind)
    .then((pulls) => {
      lastFetchedAt.set(kind, Date.now());
      const merged = pulls.map((pull) => mergeStateCache.has(pull.id) && mergeStateCache.get(pull.id)?.updatedAt === pull.updatedAt ? { ...pull, ...mergeStateCache.get(pull.id)?.state } : pull);
      queueCache.set(kind, merged);
      renderCounts();
      if (kind === state.kind) applyQueue(merged);
      if (kind === state.kind) void scoreWithJev(merged);
      if (kind === state.kind) void ensureGroups();
      void loadMergeStates(kind, merged).catch((error: unknown) => console.warn('merge states failed', errorMessage(error)));
    })
    .catch((error: unknown) => {
      if (kind !== state.kind) return;
      toast(`GitHub: ${errorMessage(error).split('\n')[0]}`, true);
      if (state.pulls.length === 0) {
        clearBootSkeletons();
        dom.empty.textContent = `Could not load: ${errorMessage(error)}`;
      }
    })
    .finally(() => {
      inFlight.delete(kind);
      renderRefreshStatus();
    });
  inFlight.set(kind, pending);
  renderRefreshStatus();
  return pending;
}

function applyQueue(pulls: PullRequest[]): void {
  const previous = selectedPull();
  state.pulls = pulls.filter((pull) => !leaving.has(pull.id)).concat([...leaving.values()].map((entry) => entry.pull));
  renderList();
  const stillThere = previous == null ? undefined : pulls.find((pull) => pull.id === previous.id);
  if (stillThere != null) {
    if (stillThere.updatedAt !== previous?.updatedAt) refreshSelectedInPlace(stillThere);
    return;
  }
  const first = visiblePulls()[0];
  if (first != null) void select(first);
}

/** Updates the open PR after a background refresh without rebuilding the description, so images and scroll stay put. */
function refreshSelectedInPlace(pull: PullRequest): void {
  renderDetailMeta(pull);
  syncQueueState(pull);
  const token = renderToken;
  bodyCache.delete(diffKey(pull));
  void loadBody(pull).then((bodyHtml) => {
    if (token !== renderToken || state.selectedId !== pull.id) return;
    const target = dom.descPane.querySelector('.description .markdown');
    if (target == null) return;
    const next = descriptionHtml(bodyHtml);
    if (target.getAttribute('data-body') === next) return;
    patchHtml(target, next);
  }, () => undefined);
  invalidateConversation(pull);
  void loadConversation(pull).then((items) => {
    if (token !== renderToken || state.selectedId !== pull.id) return;
    const section = dom.descPane.querySelector('[data-conversation]');
    if (section != null) renderConversation(section, items);
  }, () => undefined);
}

/** Replaces children only where the markup differs, keeping existing <img>/<video> nodes (and their decoded pixels) alive. */
function patchHtml(target: Element, html: string): void {
  target.setAttribute('data-body', html);
  const next = document.createElement('div');
  next.innerHTML = html;
  const current = [...target.children];
  const incoming = [...next.children];
  if (current.length !== incoming.length) {
    target.replaceChildren(...incoming);
    return;
  }
  incoming.forEach((node, index) => {
    const existing = current[index];
    if (existing != null && existing.outerHTML !== node.outerHTML) existing.replaceWith(node);
  });
}

const FIND_HIGHLIGHT = 'pr-find';
const FIND_CURRENT = 'pr-find-current';
let findHits: FindHit[] = [];
let findIndex = -1;
let findTimer = 0;

function findBar(): { bar: HTMLElement; input: HTMLInputElement; count: HTMLElement } {
  return { bar: element('find-bar'), input: element<HTMLInputElement>('find-input'), count: element('find-count') };
}

function openFind(): void {
  const { bar, input } = findBar();
  bar.hidden = false;
  const selection = window.getSelection()?.toString().trim() ?? '';
  if (selection !== '' && selection.length < 120 && !selection.includes('\n')) input.value = selection;
  input.focus();
  input.select();
  runFind();
}

function closeFind(): void {
  const { bar } = findBar();
  bar.hidden = true;
  clearFindHighlights();
  findHits = [];
  findIndex = -1;
}

function clearFindHighlights(): void {
  CSS.highlights?.delete(FIND_HIGHLIGHT);
  CSS.highlights?.delete(FIND_CURRENT);
  diffView.clearLineMark();
}

function runFind(): void {
  const { input, count } = findBar();
  const query = input.value.trim();
  clearFindHighlights();
  if (query.length === 0) {
    findHits = [];
    findIndex = -1;
    count.textContent = '';
    return;
  }
  const textHits = findInDom(dom.descPane, query);
  findHits = [...textHits, ...findInDiff(currentFiles, query)];
  const ranges = textHits.flatMap((hit) => (hit.kind === 'text' ? [hit.range] : []));
  if (ranges.length > 0 && typeof Highlight !== 'undefined') CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges));
  findIndex = findHits.length === 0 ? -1 : 0;
  showFindHit();
}

function stepFind(delta: number): void {
  if (findHits.length === 0) return;
  findIndex = (findIndex + delta + findHits.length) % findHits.length;
  showFindHit();
}

function showFindHit(): void {
  const { count } = findBar();
  CSS.highlights?.delete(FIND_CURRENT);
  if (findIndex < 0) {
    count.textContent = findBar().input.value.trim() === '' ? '' : 'No matches';
    count.classList.toggle('none', findBar().input.value.trim() !== '');
    return;
  }
  count.classList.remove('none');
  const hit = findHits[findIndex];
  if (hit == null) return;
  count.textContent = `${findIndex + 1} of ${findHits.length}${hit.kind === 'diff' ? ` · ${hit.fileName.split('/').pop()}:${hit.lineNumber}` : ''}`;
  if (hit.kind === 'text') {
    diffView.clearLineMark();
    if (typeof Highlight !== 'undefined') CSS.highlights.set(FIND_CURRENT, new Highlight(hit.range));
    const rect = hit.range.getBoundingClientRect();
    const pane = dom.descPane.getBoundingClientRect();
    if (rect.top < pane.top + 40 || rect.bottom > pane.bottom - 40) glideScrollTo(dom.descPane, dom.descPane.scrollTop + rect.top - pane.top - pane.height / 3);
    return;
  }
  diffView.scrollToLine(hit.fileId, hit.lineNumber, hit.side);
}

function wireFindBar(): void {
  const { input } = findBar();
  input.addEventListener('input', () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(runFind, 60);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      stepFind(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    } else if (event.key === 'g' && event.metaKey) {
      event.preventDefault();
      stepFind(event.shiftKey ? -1 : 1);
    }
  });
  element('find-next').addEventListener('click', () => stepFind(1));
  element('find-prev').addEventListener('click', () => stepFind(-1));
  element('find-close').addEventListener('click', closeFind);
}

function setPastedOrder(order: PastedOrder | null): void {
  pastedOrder = order;
  if (order == null) localStorage.removeItem(PASTED_ORDER_KEY);
  else localStorage.setItem(PASTED_ORDER_KEY, JSON.stringify({ numbers: order.numbers, headings: [...order.headings] }));
  invalidateList();
  renderList();
  renderPastedChip();
  const first = visiblePulls()[0];
  if (order != null && first != null) void select(first);
}

function renderPastedChip(): void {
  const chip = document.getElementById('pasted-order');
  if (chip == null) return;
  chip.hidden = pastedOrder == null;
  if (pastedOrder == null) return;
  const matched = state.pulls.filter((pull) => pastedOrder?.numbers.includes(pull.number)).length;
  chip.querySelector('.pasted-count')!.textContent = `${matched}/${pastedOrder.numbers.length}`;
}

function applyPastedText(text: string): boolean {
  const order = parsePastedOrder(text);
  if (order.numbers.length < 2) return false;
  setPastedOrder(order);
  const matched = state.pulls.filter((pull) => order.numbers.includes(pull.number)).length;
  const missing = order.numbers.length - matched;
  toast(`Sorted by your list · ${matched} PR${matched === 1 ? '' : 's'} in this view${missing > 0 ? ` · ${missing} not here (other view or closed)` : ''} · ⌥⌫ to clear`);
  return true;
}

document.addEventListener('paste', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (applyPastedText(text)) event.preventDefault();
});

function switchKind(kind: QueueKind): void {
  state.kind = kind;
  state.checkedIds.clear();
  state.selectedId = null;
  dom.viewTitle.textContent = VIEW_TITLES[kind];
  document.querySelectorAll<HTMLButtonElement>('.views button').forEach((button) => button.classList.toggle('active', button.dataset.kind === kind));
  state.pulls = queueCache.get(kind) ?? [];
  renderList();
  const first = visiblePulls()[0];
  if (first != null) void select(first);
  void scoreWithJev(state.pulls);
  renderRefreshStatus();
  groupsSignature = '';
  stableOrder.reset();
  void ensureGroups();
  void refresh(kind);
}

function checkedPulls(): PullRequest[] {
  return [...state.checkedIds].map((id) => pullById(id)).filter((pull): pull is PullRequest => pull != null);
}

function renderBulkBar(): void {
  const checked = checkedPulls();
  const hasSelection = checked.length > 0;
  syncMergeLabel();
  setVisibleWithMotion(dom.bulkBar, hasSelection);
  dom.list.classList.toggle('selecting', hasSelection);
  if (!hasSelection) return;
  const readyCount = checked.filter(isReady).length;
  dom.bulkCount.innerHTML = `<b>${checked.length}</b> selected${readyCount < checked.length ? ` · <span class="warn">${checked.length - readyCount} not ready</span>` : ''}`;
  dom.bulkMerge.disabled = checked.every((pull) => pull.isDraft || pull.mergeable === 'CONFLICTING');
  dom.bulkApprove.disabled = checked.every(isOwnPull);
  dom.bulkApprove.title = dom.bulkApprove.disabled ? 'You can’t approve your own pull requests' : 'Approve selected  ⇧A';
}

function syncCheckedRows(): void {
  virtualList.forEachRendered((element) => {
    const isChecked = state.checkedIds.has(element.dataset.key ?? '');
    if (element.classList.contains('checked') === isChecked) return;
    element.classList.toggle('checked', isChecked);
    element.querySelector('.check-box')?.setAttribute('aria-checked', String(isChecked));
  });
}

function setChecked(ids: Iterable<string>, isChecked: boolean): void {
  for (const id of ids) {
    if (isChecked) state.checkedIds.add(id);
    else state.checkedIds.delete(id);
  }
  syncCheckedRows();
  renderBulkBar();
}

let checkAnchorId: string | null = null;

function toggleChecked(id: string, isRange: boolean): void {
  const pulls = visiblePulls();
  const anchorIndex = pulls.findIndex((pull) => pull.id === checkAnchorId);
  const targetIndex = pulls.findIndex((pull) => pull.id === id);
  if (isRange && anchorIndex >= 0 && targetIndex >= 0) {
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    setChecked(pulls.slice(start, end + 1).map((pull) => pull.id), true);
    return;
  }
  checkAnchorId = id;
  setChecked([id], !state.checkedIds.has(id));
}

function toggleCheckedCurrent(isRange: boolean): void {
  if (state.selectedId != null) toggleChecked(state.selectedId, isRange);
}

let visualAnchorId: string | null = null;

function toggleVisualMode(): void {
  if (visualAnchorId != null) {
    visualAnchorId = null;
    dom.list.classList.remove('visual');
    toast(`${state.checkedIds.size} selected`);
    return;
  }
  if (state.selectedId == null) return;
  visualAnchorId = state.selectedId;
  dom.list.classList.add('visual');
  setChecked([state.selectedId], true);
  toast('Visual mode: J/K to extend, ⌘↵ merge, ⇧A approve, Esc to exit');
}

function syncVisualRange(): void {
  if (visualAnchorId == null || state.selectedId == null) return;
  const pulls = visiblePulls();
  const anchor = pulls.findIndex((pull) => pull.id === visualAnchorId);
  const cursor = pulls.findIndex((pull) => pull.id === state.selectedId);
  if (anchor < 0 || cursor < 0) return;
  const [start, end] = anchor < cursor ? [anchor, cursor] : [cursor, anchor];
  state.checkedIds = new Set(pulls.slice(start, end + 1).map((pull) => pull.id));
  syncCheckedRows();
  renderBulkBar();
}

function extendSelection(delta: number): void {
  if (state.selectedId == null) return;
  if (!state.checkedIds.has(state.selectedId)) setChecked([state.selectedId], true);
  movePull(delta);
  if (state.selectedId != null) setChecked([state.selectedId], true);
}

function selectAllVisible(): void {
  const pulls = visiblePulls();
  const isAllChecked = pulls.every((pull) => state.checkedIds.has(pull.id));
  setChecked(pulls.map((pull) => pull.id), !isAllChecked);
}

function selectReady(): void {
  setChecked(visiblePulls().filter(isReady).map((pull) => pull.id), true);
}

function selectUnready(): void {
  const unready = state.pulls.filter(needsAttention);
  if (unready.length === 0) {
    toast('Every PR is ready');
    return;
  }
  setChecked(unready.map((pull) => pull.id), true);
  toast(`Selected ${unready.length} PR${unready.length === 1 ? '' : 's'} that need attention · ⇧X to fix with an agent`);
}

function clearChecked(): void {
  checkAnchorId = null;
  visualAnchorId = null;
  dom.list.classList.remove('visual');
  setChecked([...state.checkedIds], false);
}

function setSmartFilter(filter: SmartFilter): void {
  state.smartFilter = state.smartFilter === filter && filter !== 'all' ? 'all' : filter;
  localStorage.setItem('smartFilter', state.smartFilter);
  renderList();
  const first = visiblePulls()[0];
  if (first != null && !visiblePulls().some((pull) => pull.id === state.selectedId)) void select(first);
}

function setSortOrder(order: SortOrder): void {
  state.sortOrder = order;
  localStorage.setItem('sortOrder', order);
  renderList();
}

function cycleSortOrder(): void {
  const orders: SortOrder[] = ['smart', 'updated', 'size'];
  const next = orders[(orders.indexOf(state.sortOrder) + 1) % orders.length] ?? 'smart';
  setSortOrder(next);
  toast(`Sort: ${dom.sort.selectedOptions[0]?.textContent ?? next}`);
}

function confirmBulkMerge(pulls: PullRequest[], method: MergeMethod): Promise<boolean> {
  const notReady = pulls.filter((pull) => !isReady(pull)).length;
  dom.bulkConfirmTitle.textContent = `${MERGE_LABELS[method]} ${pulls.length} pull request${pulls.length === 1 ? '' : 's'}?`;
  dom.bulkConfirmList.innerHTML = pulls
    .map((pull) => `<li>${statusIcon(pull)}<span class="id">#${pull.number}</span><span class="t">${escapeHtml(pull.title)}</span>${isReady(pull) ? '<span class="tone ok"><i></i>Ready</span>' : `<span class="tone wait"><i></i>${escapeHtml(mergeState(pull).label)}</span>`}</li>`)
    .join('');
  dom.bulkConfirmNote.textContent = notReady > 0 ? `${notReady} not ready. GitHub will reject any that branch protection blocks; the rest still merge.` : 'Merged one at a time, in this order. Branch protection and merge queues still apply.';
  dom.bulkConfirm.returnValue = '';
  dom.bulkConfirm.showModal();
  return new Promise((resolve) => dom.bulkConfirm.addEventListener('close', () => resolve(dom.bulkConfirm.returnValue === 'ok'), { once: true }));
}

const LEAVE_AFTER_MS = 3_000;
const LEAVE_ANIMATION_MS = 220;
const leaveTimers = new Map<string, number>();
const failedMerges = new Map<string, number>();

function markPending(pull: PullRequest, label: string): void {
  leaving.set(pull.id, { pull, label, isPending: true });
  window.clearTimeout(leaveTimers.get(pull.id));
  invalidateList();
  renderList();
  if (selectedPull()?.id === pull.id) renderDetailMeta(pull);
}

function rollbackPending(pull: PullRequest): void {
  leaving.delete(pull.id);
  window.clearTimeout(leaveTimers.get(pull.id));
  leaveTimers.delete(pull.id);
  invalidateList();
  renderList();
  failedMerges.set(pull.id, Date.now());
  invalidateList();
  renderList();
  window.setTimeout(() => {
    failedMerges.delete(pull.id);
    virtualList.element(pull.id)?.classList.remove('merge-failed');
  }, 4_000);
  if (selectedPull()?.id === pull.id) renderDetailMeta(pull);
}

function markLeaving(pull: PullRequest, label: string): void {
  leaving.set(pull.id, { pull, label });
  invalidateList();
  renderList();
  scheduleLeave(pull.id);
}

function scheduleLeave(id: string): void {
  window.clearTimeout(leaveTimers.get(id));
  leaveTimers.set(id, window.setTimeout(() => finishLeaving(id), LEAVE_AFTER_MS));
}

function finishLeaving(id: string): void {
  if (!leaving.has(id) || leaving.get(id)?.isPending === true) return;
  if (state.selectedId === id) {
    scheduleLeave(id);
    return;
  }
  const row = virtualList.element(id);
  const remove = (): void => {
    leaving.delete(id);
    leaveTimers.delete(id);
    state.pulls = state.pulls.filter((candidate) => candidate.id !== id);
    invalidateList();
    renderList();
  };
  if (row == null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return remove();
  row.classList.add('removing');
  window.setTimeout(remove, LEAVE_ANIMATION_MS);
}

const MERGE_CONCURRENCY = 3;

async function runMerge(pull: PullRequest, isQueued: boolean): Promise<string | null> {
  markPending(pull, isQueued ? 'Queueing…' : 'Merging…');
  try {
    await mergePull(pull, MERGE_METHOD);
    markLeaving(pull, isQueued ? 'Queued' : 'Merged');
    return null;
  } catch (error) {
    rollbackPending(pull);
    void recheckMergeState(pull);
    return `#${pull.number}: ${errorMessage(error).split('\n')[0]}`;
  }
}

/** After a merge is refused, ask GitHub again so a conflict (or any other blocker) shows up right away instead of on a later refresh. */
async function recheckMergeState(pull: PullRequest): Promise<void> {
  mergeStateCache.delete(pull.id);
  const kind = state.kind;
  await loadMergeStates(kind, [pull]).catch((error: unknown) => console.warn('merge state recheck failed', errorMessage(error)));
  const fresh = state.pulls.find((candidate) => candidate.id === pull.id);
  if (fresh != null && isConflicted(fresh) && !isConflicted(pull)) toast(`#${pull.number} now has merge conflicts with ${pull.baseRefName}`, true);
}

async function bulkMerge(): Promise<void> {
  const pulls = checkedPulls().filter((pull) => !pull.isDraft && pull.mergeable !== 'CONFLICTING' && !leaving.has(pull.id));
  if (pulls.length === 0) return;
  const queueFlags = await Promise.all(pulls.map(usesMergeQueue));
  const isAllQueued = queueFlags.every(Boolean);
  if (!isAllQueued && !(await confirmBulkMerge(pulls, MERGE_METHOD))) return;
  const verb = isAllQueued ? 'Queued' : 'Merged';
  clearChecked();
  pulls.forEach((pull, index) => markPending(pull, queueFlags[index] ? 'Queueing…' : 'Merging…'));
  toast(`${isAllQueued ? 'Queueing' : 'Merging'} ${pulls.length} pull request${pulls.length === 1 ? '' : 's'}…`);
  const failures: string[] = [];
  const work = pulls.map((pull, index) => ({ pull, isQueued: queueFlags[index] ?? false }));
  const worker = async (): Promise<void> => {
    for (let next = work.shift(); next != null; next = work.shift()) {
      const failure = await runMerge(next.pull, next.isQueued);
      if (failure != null) failures.push(failure);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MERGE_CONCURRENCY, pulls.length) }, worker));
  const done = pulls.length - failures.length;
  toast(failures.length === 0 ? `${verb} ${done} pull request${done === 1 ? '' : 's'}` : `${verb} ${done}, failed ${failures.length} — ${failures.join(' · ')}`, failures.length > 0);
  void refresh(state.kind);
}

function isOwnPull(pull: PullRequest): boolean {
  return viewer != null && pull.author?.login.toLowerCase() === viewer.toLowerCase();
}

async function bulkApprove(): Promise<void> {
  const checked = checkedPulls();
  const pulls = checked.filter((pull) => !isOwnPull(pull));
  if (pulls.length === 0) {
    if (checked.length > 0) toast('You can’t approve your own pull requests', true);
    return;
  }
  dom.bulkApprove.disabled = true;
  const results = await Promise.allSettled(pulls.map((pull) => approvePull(pull)));
  const failed = results.filter((result) => result.status === 'rejected').length;
  const skipped = checked.length - pulls.length;
  const skippedNote = skipped > 0 ? ` · skipped ${skipped} of yours` : '';
  toast(failed === 0 ? `Approved ${pulls.length}${skippedNote}` : `Approved ${pulls.length - failed}, failed ${failed}${skippedNote}`, failed > 0);
  dom.bulkApprove.disabled = false;
  void refresh(state.kind);
}

async function approveSelected(): Promise<void> {
  const pull = selectedPull();
  if (pull == null || dom.approve.disabled) return;
  if (isOwnPull(pull)) {
    toast('You can’t approve your own pull request', true);
    return;
  }
  dom.approve.disabled = true;
  try {
    await approvePull(pull);
    toast(`Approved #${pull.number}`);
    void refresh(state.kind);
  } catch (error) {
    toast(`Approve #${pull.number} failed: ${errorMessage(error)}`, true);
  } finally {
    dom.approve.disabled = isOwnPull(pull);
  }
}

function confirmMerge(pull: PullRequest, method: MergeMethod): Promise<boolean> {
  dom.confirmTitle.textContent = `${MERGE_LABELS[method]} #${pull.number}?`;
  dom.confirmText.innerHTML = `${escapeHtml(pull.title)}<br><span class="muted">${escapeHtml(pull.headRefName)} → ${escapeHtml(pull.baseRefName)} · ${escapeHtml(pull.repository.nameWithOwner)}</span>`;
  dom.confirm.returnValue = '';
  dom.confirm.showModal();
  return new Promise((resolve) => dom.confirm.addEventListener('close', () => resolve(dom.confirm.returnValue === 'ok'), { once: true }));
}

async function mergeSelected(): Promise<void> {
  const pull = selectedPull();
  if (pull == null || dom.merge.disabled || leaving.has(pull.id)) return;
  const isQueued = await usesMergeQueue(pull);
  if (!isQueued && !(await confirmMerge(pull, MERGE_METHOD))) return;
  const failure = await runMerge(pull, isQueued);
  if (failure != null) toast(`Merge #${pull.number} failed: ${failure.replace(/^#\d+: /, '')}`, true);
  else toast(isQueued ? `#${pull.number} added to the merge queue` : `Merged #${pull.number}`);
  void refresh(state.kind);
}

function toggleStyle(): void {
  state.diffStyle = state.diffStyle === 'split' ? 'unified' : 'split';
  localStorage.setItem('diffStyle', state.diffStyle);
  diffView.setStyle(state.diffStyle);
  toast(state.diffStyle === 'split' ? 'Split view' : 'Unified view');
}

type ReviewMode = 'stacked' | 'side';
let layoutRef: Layout | null = null;
const reviewMode: ReviewMode = 'side';

function applyReviewMode(): void {
  const isSide = reviewMode === 'side';
  element('app').classList.toggle('mode-side', isSide);
  diffView.setFlush(isSide);
  if (isSide) dom.inspector.append(dom.diffRoot);
  else dom.bodySplit.insertBefore(dom.diffRoot, dom.bodySplit.querySelector('.resizer[data-resize="inspector"]'));
  const pull = selectedPull();
  if (pull != null) renderDetail(pull);
  layoutRef?.refit();
}

const PRESET_LABELS: Record<LayoutPreset, string> = { review: 'Review', diff: 'Diff focus', read: 'Read description' };

function applyLayoutPreset(preset: LayoutPreset): void {
  layout.applyPreset(preset);
  toast(`Layout: ${PRESET_LABELS[preset]}`);
}

const layout = new Layout(element('app'), () => syncPaneButtons());
layoutRef = layout;
const lightbox = new Lightbox((url) => void openInBrowser(url).catch((error: unknown) => toast(`Opening ${url} failed: ${errorMessage(error)}`, true)));

function descriptionRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#pr-body-split .description');
}

function openMedia(index = 0): void {
  const root = descriptionRoot();
  const items = root == null ? [] : collectMedia(root);
  if (!lightbox.open(items, index)) toast(`No images, videos or HTML previews in #${selectedPull()?.number ?? ''}'s description`);
}

function openMediaFrom(target: HTMLElement): boolean {
  const root = descriptionRoot();
  if (root == null || !root.contains(target)) return false;
  const items = collectMedia(root);
  const index = items.findIndex((item) => item.source === target || item.source.contains(target) || target.contains(item.source));
  if (index < 0) return false;
  return lightbox.open(items, index);
}
const listPane = element('list-pane');
new ResizeObserver(([entry]) => listPane.classList.toggle('narrow', (entry?.contentRect.width ?? 999) < 400)).observe(listPane);
const commands = new CommandRegistry();
const hasPull = (): boolean => selectedPull() != null;
const hasFiles = (): boolean => currentFiles.length > 0;

const TESTED_THRESHOLD = 0.75;

function isTested(pull: PullRequest): boolean {
  return (aiResults.get(aiKey(pull))?.tested ?? 0) >= TESTED_THRESHOLD;
}

let triagePulls: PullRequest[] = [];
const triageExcluded = new Set<string>();

function triageIncluded(): Set<AttentionReason> {
  return new Set(ATTENTION_ORDER.filter((reason) => triagePulls.some((pull) => !triageExcluded.has(pull.id) && attentionReasons(pull).includes(reason))));
}

function triageTargets(): PullRequest[] {
  return triagePulls.filter((pull) => !triageExcluded.has(pull.id));
}

function renderTriageSummary(): void {
  const count = triageTargets().length;
  const plural = count === 1 ? '' : 's';
  dom.triageCopy.disabled = count === 0;
  dom.triageCopy.firstChild!.textContent = `Copy prompt for ${count} PR${plural} `;
  dom.triageDevin.disabled = count === 0;
  element('triage-devin-label').textContent = `Send to ${count} Devin session${plural}`;
  dom.triage.querySelectorAll<HTMLInputElement>('input[data-pull]').forEach((input) => (input.checked = !triageExcluded.has(input.dataset.pull ?? '')));
  dom.triage.querySelectorAll<HTMLInputElement>('input[data-reason]').forEach((input) => {
    const ids = triagePulls.filter((pull) => attentionReasons(pull).includes(input.dataset.reason as AttentionReason)).map((pull) => pull.id);
    const picked = ids.filter((id) => !triageExcluded.has(id)).length;
    input.checked = picked === ids.length;
    input.indeterminate = picked > 0 && picked < ids.length;
    input.closest('.triage-section')?.querySelector('.triage-count')?.replaceChildren(picked === ids.length ? `${ids.length}` : `${picked}/${ids.length}`);
  });
}

function setTriagePicked(ids: readonly string[], isPicked: boolean): void {
  ids.forEach((id) => (isPicked ? triageExcluded.delete(id) : triageExcluded.add(id)));
  renderTriageSummary();
}

function openTriage(): void {
  const scope = state.checkedIds.size > 0 ? checkedPulls() : state.pulls;
  triagePulls = scope.filter(needsAttention);
  triageExcluded.clear();
  if (triagePulls.length === 0) {
    toast(state.checkedIds.size > 0 ? 'Nothing in the selection needs attention' : 'Every PR is approved, green and conflict-free');
    return;
  }
  dom.triageTitle.textContent = `${triagePulls.length} PR${triagePulls.length === 1 ? '' : 's'} need attention${state.checkedIds.size > 0 ? ' in selection' : ''}`;
  dom.triageSections.innerHTML = ATTENTION_ORDER.map((reason) => {
    const pulls = triagePulls.filter((pull) => attentionReasons(pull).includes(reason));
    if (pulls.length === 0) return '';
    const meta = ATTENTION_META[reason];
    const rows = pulls.map((pull) => `<li><label class="triage-row"><input type="checkbox" data-pull="${escapeHtml(pull.id)}" checked />${statusIcon(pull)}<span class="id">#${pull.number}</span><span class="t">${escapeHtml(pull.title)}</span><span class="age">${relativeTime(pull.updatedAt)}</span></label></li>`).join('');
    return `<section class="triage-section tone-${meta.tone}"><label class="triage-head"><input type="checkbox" data-reason="${reason}" checked /><i class="triage-dot"></i><span>${meta.title}</span><span class="triage-count">${pulls.length}</span></label><ol class="bulk-list">${rows}</ol></section>`;
  }).join('');
  renderTriageSummary();
  dom.triage.returnValue = '';
  dom.triage.showModal();
  dom.triageCopy.focus();
  dom.triageMessage.value = triageMessageDraft;
}

dom.triage.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.pull != null) setTriagePicked([input.dataset.pull], input.checked);
  else if (input.dataset.reason != null) setTriagePicked(triagePulls.filter((pull) => attentionReasons(pull).includes(input.dataset.reason as AttentionReason)).map((pull) => pull.id), input.checked);
});
let triageMessageDraft = '';
dom.triageMessage.addEventListener('input', () => (triageMessageDraft = dom.triageMessage.value));

dom.triage.addEventListener('keydown', (event) => {
  if (event.target === dom.triageMessage && event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) return;
  if (event.target !== dom.triageMessage && event.key.toLowerCase() === 'a' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    setTriagePicked(triagePulls.map((pull) => pull.id), triageExcluded.size > 0);
    return;
  }
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || dom.triageDevin.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  dom.triage.close('devin');
});
dom.triage.addEventListener('close', () => {
  const included = triageIncluded();
  const targets = triageTargets();
  if (targets.length === 0) return;
  if (dom.triage.returnValue === 'devin') {
    void sendTriageToDevin(targets, dom.triageMessage.value.trim() || BULK_FIX_MESSAGE);
    return;
  }
  if (dom.triage.returnValue !== 'copy') return;
  void navigator.clipboard.writeText(buildAgentPrompt(targets, included)).then(
    () => toast(`Copied agent prompt for ${targets.length} PR${targets.length === 1 ? '' : 's'} · paste it into your agent`),
    () => toast('Clipboard unavailable', true),
  );
});

const DEVIN_SESSION_PATTERN = /https:\/\/(?:[a-z0-9-]+\.)*(?:devin\.ai|devinenterprise\.com)\/(?:desktop\/)?sessions?\/[0-9a-f]{16,64}/i;

function devinSessionUrl(html: string): string | null {
  const match = DEVIN_SESSION_PATTERN.exec(html.replace(/&amp;/g, '&'));
  return match == null ? null : match[0].replace('/desktop/session/', '/sessions/');
}

async function findDevinSession(pull: PullRequest): Promise<string | null> {
  const fromBody = devinSessionUrl(await loadBody(pull).catch(() => ''));
  if (fromBody != null) return fromBody;
  const items = await loadConversation(pull).catch((): ConversationItem[] => []);
  for (const item of items) {
    const url = devinSessionUrl(item.html);
    if (url != null) return url;
  }
  return null;
}

const PREVIEW_HOST_PATTERN = /(?:^|\.)(?:preview\.[a-z0-9-]+\.[a-z]{2,}|vercel\.app|netlify\.app|pages\.dev|workers\.dev|onrender\.com|fly\.dev|up\.railway\.app|herokuapp\.com|amplifyapp\.com|web\.app|firebaseapp\.com|surge\.sh|github\.io)$/i;
const PREVIEW_WORD_PATTERN = /preview|deploy|staging/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const IGNORED_PREVIEW_HOSTS = /(?:^|\.)(?:github\.com|githubusercontent\.com|vercel\.com|netlify\.com|devin\.ai|devinenterprise\.com|datadoghq\.com|shields\.io)$/i;

function previewUrlsIn(html: string): string[] {
  const text = html.replace(/&amp;/g, '&');
  const urls = [...new Set([...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:!?]+$/, '')))];
  return urls.filter((url) => {
    const host = URL.canParse(url) ? new URL(url).hostname : '';
    if (host === '' || IGNORED_PREVIEW_HOSTS.test(host)) return false;
    return PREVIEW_HOST_PATTERN.test(host) || (/(?:^|[.-])(?:pr|preview)-?\d+[.-]/i.test(host) && PREVIEW_WORD_PATTERN.test(text));
  });
}

async function findPreview(pull: PullRequest): Promise<string | null> {
  const items = await loadConversation(pull).catch((): ConversationItem[] => []);
  const fromComments = [...items].reverse().flatMap((item) => previewUrlsIn(item.html));
  if (fromComments[0] != null) return fromComments[0];
  const fromBody = previewUrlsIn(await loadBody(pull).catch(() => ''));
  return fromBody[0] ?? null;
}

async function syncPreviewButton(pull: PullRequest): Promise<void> {
  const button = document.getElementById('open-preview') as HTMLButtonElement | null;
  if (button == null) return;
  const url = await findPreview(pull);
  if (selectedPull()?.id !== pull.id) return;
  button.disabled = url == null;
  button.dataset.tip = url == null ? 'No preview deployment found' : `Open preview  P\n${url}`;
}

async function openPreview(): Promise<void> {
  const pull = selectedPull();
  if (pull == null) return;
  const url = await findPreview(pull);
  if (url == null) {
    toast(`No preview deployment found on #${pull.number}`, true);
    return;
  }
  await openInBrowser(url).then(
    () => toast(`Opened preview for #${pull.number}`),
    (error: unknown) => toast(`Opening preview for #${pull.number} failed: ${errorMessage(error)}`, true),
  );
}

async function syncDevinButton(pull: PullRequest): Promise<void> {
  const button = document.getElementById('open-devin') as HTMLButtonElement | null;
  if (button == null) return;
  const url = await findDevinSession(pull);
  if (selectedPull()?.id !== pull.id) return;
  button.disabled = url == null;
  button.dataset.tip = url == null ? 'No Devin session linked on this PR' : 'Open Devin session  D';
  const messageButton = document.getElementById('message-devin') as HTMLButtonElement | null;
  if (messageButton == null) return;
  messageButton.disabled = url == null;
  messageButton.dataset.tip = url == null ? 'No Devin session linked on this PR' : 'Message Devin session  ⇧D';
}

async function openDevinSession(): Promise<void> {
  const pull = selectedPull();
  if (pull == null) return;
  const url = await findDevinSession(pull);
  if (url == null) {
    toast(`No Devin session linked on #${pull.number}`, true);
    return;
  }
  await openInBrowser(url).then(
    () => toast(`Opened Devin session for #${pull.number}`),
    (error: unknown) => toast(`Opening Devin session for #${pull.number} failed: ${errorMessage(error)}`, true),
  );
}

function openSelectedOnGitHub(): void {
  const pull = selectedPull();
  if (pull == null) return;
  void openInBrowser(pull.url).then(
    () => toast(`Opened #${pull.number} on GitHub`),
    (error: unknown) => toast(`Opening #${pull.number} on GitHub failed: ${errorMessage(error)}`, true),
  );
}

function copyText(text: string, label: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${label}: ${text}`),
    () => toast('Clipboard unavailable', true),
  );
}

let themeId = localStorage.getItem('themeId') ?? (localStorage.getItem('theme') === 'dark' || localStorage.getItem('theme') === 'light' ? (localStorage.getItem('theme') as string) : SYSTEM_THEME_ID);
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedAppTheme(id: string = themeId): AppTheme {
  const fallback = themeById(systemDark.matches ? 'dark' : 'light') ?? THEMES[0]!;
  return id === SYSTEM_THEME_ID ? fallback : themeById(id) ?? fallback;
}

let diffThemeTimer = 0;

function applyTheme(id: string = themeId, diffDelayMs = 0): void {
  const theme = resolvedAppTheme(id);
  applyThemeColors(document.documentElement, theme);
  window.clearTimeout(diffThemeTimer);
  if (diffDelayMs <= 0) {
    diffView.setTheme(theme.mode, theme.diff);
    return;
  }
  diffThemeTimer = window.setTimeout(() => diffView.setTheme(theme.mode, theme.diff), diffDelayMs);
}

function setTheme(id: string): void {
  themeId = id;
  localStorage.setItem('themeId', id);
  applyTheme();
  toast(`Theme: ${id === SYSTEM_THEME_ID ? `System (${resolvedAppTheme().name})` : resolvedAppTheme().name}`);
}

const themePicker = new ThemePicker({
  current: () => themeId,
  preview: (id) => applyTheme(id, 220),
  commit: setTheme,
  cancel: () => applyTheme(),
});

type CommentMode = { kind: 'github' } | { kind: 'devin'; sessionId: string };

const commentDrafts = new Map<string, string>();
let commentTarget: PullRequest | null = null;
let commentMode: CommentMode = { kind: 'github' };

const draftKey = (pull: PullRequest, mode: CommentMode): string => (mode.kind === 'devin' ? `devin:${pull.id}` : pull.id);

function showCommentDialog(pull: PullRequest, mode: CommentMode): void {
  commentTarget = pull;
  commentMode = mode;
  dom.commentDialog.dataset.mode = mode.kind;
  dom.commentTitle.textContent = mode.kind === 'devin' ? `Message Devin about #${pull.number}` : `Comment on #${pull.number}`;
  dom.commentHint.textContent = mode.kind === 'devin' ? `Sent straight to the linked Devin session · ${pull.title}` : `${pull.repository.nameWithOwner} · ${pull.title}`;
  dom.commentBody.placeholder = mode.kind === 'devin' ? 'Tell Devin what to do… (goes to the session, not GitHub)' : 'Leave a comment… (markdown, @mentions work)';
  dom.commentSendLabel.textContent = mode.kind === 'devin' ? 'Send to Devin' : 'Comment';
  dom.commentBody.value = commentDrafts.get(draftKey(pull, mode)) ?? '';
  dom.commentSend.disabled = dom.commentBody.value.trim() === '';
  dom.commentDialog.showModal();
  dom.commentBody.focus();
  dom.commentBody.setSelectionRange(dom.commentBody.value.length, dom.commentBody.value.length);
}

function openCommentDialog(): void {
  const pull = selectedPull();
  if (pull != null) showCommentDialog(pull, { kind: 'github' });
}

function devinSessionId(url: string): string | null {
  return /\/sessions\/([0-9a-f]{16,64})/i.exec(url)?.[1] ?? null;
}

async function openDevinMessageDialog(): Promise<void> {
  const pull = selectedPull();
  if (pull == null) return;
  const url = await findDevinSession(pull);
  const sessionId = url == null ? null : devinSessionId(url);
  if (sessionId == null) {
    toast(`No Devin session linked on #${pull.number}`, true);
    return;
  }
  if (selectedPull()?.id === pull.id) showCommentDialog(pull, { kind: 'devin', sessionId });
}

function closeCommentDialog(): void {
  if (commentTarget != null) {
    const draft = dom.commentBody.value;
    const key = draftKey(commentTarget, commentMode);
    if (draft.trim() === '') commentDrafts.delete(key);
    else commentDrafts.set(key, draft);
  }
  dom.commentDialog.close();
}

async function submitComment(): Promise<void> {
  const pull = commentTarget;
  const mode = commentMode;
  const body = dom.commentBody.value.trim();
  if (pull == null || body === '' || dom.commentSend.disabled) return;
  if (mode.kind === 'devin') {
    sendToDevin(pull, mode.sessionId, body);
    return;
  }
  dom.commentSend.disabled = true;
  try {
    await commentOnPull(pull, body);
    commentDrafts.delete(pull.id);
    dom.commentBody.value = '';
    commentTarget = null;
    dom.commentDialog.close();
    toast(`Commented on #${pull.number}`);
    invalidateConversation(pull);
    if (selectedPull()?.id === pull.id) renderDetail(pull);
  } catch (error) {
    toast(`Comment on #${pull.number} failed: ${errorMessage(error)}`, true);
    dom.commentSend.disabled = false;
  }
}

function sendToDevin(pull: PullRequest, sessionId: string, body: string): void {
  commentDrafts.delete(draftKey(pull, commentMode));
  dom.commentBody.value = '';
  commentTarget = null;
  dom.commentDialog.close();
  deliverToDevin(pull, sessionId, body);
}

const fixingWithDevin = new Set<string>();

async function devinSessionFor(pull: PullRequest): Promise<string | null> {
  const url = await findDevinSession(pull);
  return url == null ? null : devinSessionId(url);
}

function setFixButtonBusy(pull: PullRequest, isBusy: boolean): void {
  if (isBusy) fixingWithDevin.add(pull.id);
  else fixingWithDevin.delete(pull.id);
  const button = document.getElementById('fix-with-devin') as HTMLButtonElement | null;
  if (button != null && selectedPull()?.id === pull.id) button.disabled = isBusy;
}

async function fixWithDevin(): Promise<void> {
  const pull = selectedPull();
  const message = pull == null ? null : devinFixMessage(pull);
  if (pull == null || message == null || fixingWithDevin.has(pull.id)) return;
  setFixButtonBusy(pull, true);
  const sessionId = await devinSessionFor(pull);
  if (sessionId == null) {
    setFixButtonBusy(pull, false);
    toast(`No Devin session linked on #${pull.number}`, true);
    return;
  }
  deliverToDevin(pull, sessionId, message, () => setFixButtonBusy(pull, false));
}

const DEVIN_BULK_CONCURRENCY = 4;

async function sendTriageToDevin(targets: readonly PullRequest[], message: string): Promise<void> {
  toast(`Finding Devin sessions for ${targets.map((pull) => `#${pull.number}`).join(', ')}…`);
  const sent: number[] = [];
  const skipped: number[] = [];
  const failures: string[] = [];
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let pull = queue.shift(); pull != null; pull = queue.shift()) {
      const sessionId = await devinSessionFor(pull).catch(() => null);
      if (sessionId == null) {
        skipped.push(pull.number);
        continue;
      }
      await messageDevinSession(sessionId, message).then(
        () => sent.push(pull.number),
        (error: unknown) => failures.push(`#${pull.number} (${errorMessage(error)})`),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(DEVIN_BULK_CONCURRENCY, targets.length) }, worker));
  const list = (numbers: number[]): string => numbers.sort((left, right) => left - right).map((number) => `#${number}`).join(', ');
  const quoted = message.length > 60 ? `${message.slice(0, 60)}…` : message;
  const parts = [sent.length > 0 ? `Sent “${quoted}” to Devin for ${list(sent)}` : `Sent “${quoted}” to no Devin sessions`];
  if (skipped.length > 0) parts.push(`no session on ${list(skipped)}`);
  if (failures.length > 0) parts.push(`failed: ${failures.join(', ')}`);
  toast(parts.join(' · '), failures.length > 0 || sent.length === 0);
}

function deliverToDevin(pull: PullRequest, sessionId: string, body: string, onSettled?: () => void): void {
  toast(`Sending to Devin · #${pull.number}…`);
  void messageDevinSession(sessionId, body).then(
    () => {
      onSettled?.();
      toast(`Sent to Devin · #${pull.number}: “${body.length > 60 ? `${body.slice(0, 60)}…` : body}”`);
    },
    (error: unknown) => {
      onSettled?.();
      if (onSettled == null) commentDrafts.set(`devin:${pull.id}`, body);
      toast(`Devin message for #${pull.number} failed: ${errorMessage(error)}`, true);
    },
  );
}

dom.commentBody.addEventListener('input', () => (dom.commentSend.disabled = dom.commentBody.value.trim() === ''));
dom.commentBody.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.stopPropagation();
    void submitComment();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeCommentDialog();
  }
});
dom.commentDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeCommentDialog();
});
dom.commentSend.addEventListener('click', () => void submitComment());
element('comment-cancel').addEventListener('click', closeCommentDialog);
element('comment-button').addEventListener('click', openCommentDialog);
element('threads-button').addEventListener('click', focusFirstOpenThread);
element('open-devin').addEventListener('click', () => void openDevinSession());
element('message-devin').addEventListener('click', () => void openDevinMessageDialog());
dom.statusBar.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('#fix-with-devin') != null) void fixWithDevin();
});
element('open-preview').addEventListener('click', () => void openPreview());

function openThemePicker(): void {
  themePicker.open();
}

function syncPaneButtons(): void {
  document.getElementById('toggle-sidebar')?.classList.toggle('on', !layout.isHidden('list'));
}

function openHelp(): void {
  let section = '';
  dom.shortcutList.innerHTML = commands
    .list()
    .map((command) => {
      const heading = command.section !== section ? `<h4>${(section = command.section)}</h4>` : '';
      const keys = command.keys.map(renderShortcut).join('<span class="or">or</span>');
      return `${heading}<div class="shortcut"><span>${command.title}</span><span class="keys">${keys}</span></div>`;
    })
    .join('');
  dom.help.showModal();
  dom.help.scrollTop = 0;
  (document.activeElement as HTMLElement | null)?.blur();
}

const VIM_COMMANDS = vimCommands();

const DIFF_SCROLL_COMMANDS: Command[] = [
  { id: 'diff-scroll-down', section: 'Diff', title: 'Scroll diff down', aliases: 'vim line', keys: ['⌘j'], run: () => diffView.stepBy(DIFF_LINE_PX * 2), isEnabled: hasPull },
  { id: 'diff-scroll-up', section: 'Diff', title: 'Scroll diff up', aliases: 'vim line', keys: ['⌘k'], run: () => diffView.stepBy(-DIFF_LINE_PX * 2), isEnabled: hasPull },
];

const COMMANDS: Command[] = [
  { id: 'update', section: 'General', title: 'Check for updates / restart into update', aliases: 'upgrade version release', keys: ['⌘⇧u'], run: () => (restartIntoUpdate != null ? restartIntoUpdate() : (toast('Checking for updates…'), checkForUpdates())) },
  { id: 'help', section: 'General', title: 'Keyboard shortcuts', keys: ['?', '⌘/'], run: openHelp },
  { id: 'find', allowWhileTyping: true, section: 'General', title: 'Find in this PR (description, conversation and diff)', aliases: 'search text body diff code', keys: ['⌘f'], run: openFind, isEnabled: hasPull },
  { id: 'filter', section: 'General', title: 'Filter pull requests', keys: ['/'], run: () => { dom.filter.focus(); dom.filter.select(); const box = dom.filter.closest<HTMLElement>('.search'); if (box != null) flash(box); } },
  { id: 'refresh', allowWhileTyping: true, section: 'General', title: 'Refresh', keys: ['r', '⌘r'], run: manualRefresh },

  { id: 'smart-all', section: 'Filter', title: 'Show all', aliases: 'clear filter', keys: ['⌥0'], run: () => setSmartFilter('all') },
  { id: 'smart-ready', section: 'Filter', title: 'Show ready to merge', aliases: 'green approved mergeable', keys: ['⌥1'], run: () => setSmartFilter('ready') },
  { id: 'smart-small', section: 'Filter', title: 'Show small diffs', aliases: 'tiny quick', keys: ['⌥2'], run: () => setSmartFilter('small') },
  { id: 'smart-recent', section: 'Filter', title: 'Show recently updated', aliases: 'new fresh', keys: ['⌥3'], run: () => setSmartFilter('recent') },
  { id: 'smart-tested', section: 'Filter', title: 'Show end-to-end tested', aliases: 'e2e verified qa proof screenshots recording', keys: ['⌥5'], run: () => setSmartFilter('tested') },
  { id: 'smart-threads', section: 'Filter', title: 'Show PRs with open review threads', aliases: 'unresolved comments threads feedback', keys: ['⌥6'], run: () => setSmartFilter('threads') },
  { id: 'smart-attention', section: 'Filter', title: 'Show PRs that need attention', aliases: 'unapproved conflicts failing blocked red yellow triage', keys: ['⌥4'], run: () => setSmartFilter('attention') },
  { id: 'paste-order', section: 'Filter', title: 'Sort by a pasted list of PRs (just ⌘V anywhere outside a text box)', aliases: 'paste order ranking priority report clipboard', keys: ['⇧o'], run: () => void navigator.clipboard.readText().then((text) => applyPastedText(text) || toast('No PR numbers found on the clipboard', true), () => toast('Press ⌘V to paste your list', true)) },
  { id: 'paste-order-clear', section: 'Filter', title: 'Clear pasted order', aliases: 'reset sort pasted', keys: ['⌥⌫'], run: () => { setPastedOrder(null); toast('Back to the normal order'); }, isEnabled: () => pastedOrder != null },
  { id: 'group', section: 'Filter', title: 'Group related work', aliases: 'cluster effort category batch smart group', keys: ['⇧t'], run: toggleGrouping },
  { id: 'regroup', section: 'Filter', title: 'Regroup', aliases: 'refresh groups cluster', keys: [], run: () => { groupsSignature = ''; localStorage.removeItem(GROUPS_CACHE_KEY); void ensureGroups(true); } },
  { id: 'sort', section: 'Filter', title: 'Cycle sort (smart / updated / smallest)', aliases: 'order', keys: ['⇧s'], run: cycleSortOrder },

  { id: 'visual', section: 'Select', title: 'Visual select mode (vim V)', aliases: 'multi range bulk vim', keys: ['⇧v'], run: toggleVisualMode, isEnabled: hasPull },
  { id: 'check', section: 'Select', title: 'Select / deselect pull request', aliases: 'check bulk multi', keys: ['e'], run: () => toggleCheckedCurrent(false), isEnabled: hasPull },
  { id: 'check-down', section: 'Select', title: 'Extend selection down', keys: ['⇧j', '⇧↓'], run: () => extendSelection(1), isEnabled: hasPull },
  { id: 'check-up', section: 'Select', title: 'Extend selection up', keys: ['⇧k', '⇧↑'], run: () => extendSelection(-1), isEnabled: hasPull },
  { id: 'check-all', section: 'Select', title: 'Select all visible', keys: ['⌘a'], run: selectAllVisible },
  { id: 'check-ready', section: 'Select', title: 'Select all ready', aliases: 'green approved', keys: ['⇧r'], run: selectReady },
  { id: 'check-unready', section: 'Select', title: 'Select all unready (conflicts, failing, not approved)', aliases: 'attention broken red yellow fix bulk', keys: ['⇧u'], run: selectUnready },
  { id: 'check-clear', section: 'Select', title: 'Clear selection', keys: ['esc', '⌫'], run: clearChecked, isEnabled: () => state.checkedIds.size > 0 },
  { id: 'bulk-approve', section: 'Select', title: 'Approve selected', aliases: 'bulk lgtm', keys: ['⇧a'], run: () => void bulkApprove(), isEnabled: () => state.checkedIds.size > 0 },

  { id: 'view-review', section: 'Views', title: 'Go to Review requested', keys: ['⌘1', 'g r'], run: () => switchKind('review') },
  { id: 'view-involved', section: 'Views', title: 'Go to Involved', keys: ['⌘2', 'g i'], run: () => switchKind('involved') },
  { id: 'view-mine', section: 'Views', title: 'Go to Created by me', keys: ['⌘3', 'g m'], run: () => switchKind('mine') },

  { id: 'toggle-sidebar', section: 'Layout', title: 'Toggle pull request list', aliases: 'hide show pane sidebar navigation queue inbox', keys: ['⌘b', '⌘\\'], run: () => layout.toggle('list') },
  { id: 'layout-review', section: 'Layout', title: 'Layout: review (list 24% · description 36% · diff)', aliases: 'preset pane default balanced', keys: ['1', '⌘⌥1'], run: () => applyLayoutPreset('review') },
  { id: 'layout-diff', section: 'Layout', title: 'Layout: diff focus (list minimal · description 26% · diff)', aliases: 'preset pane code wide', keys: ['2', '⌘⌥2'], run: () => applyLayoutPreset('diff') },
  { id: 'layout-read', section: 'Layout', title: 'Layout: read description (list minimal · description 62% · diff)', aliases: 'preset pane body middle', keys: ['3', '⌘⌥3'], run: () => applyLayoutPreset('read') },
  { id: 'focus-mode', section: 'Layout', title: 'Focus mode (hide all panels)', aliases: 'zen fullscreen hide panes', keys: ['⌘.', 'z'], run: () => layout.toggleFocus() },
  { id: 'theme', section: 'Layout', title: 'Choose theme', aliases: 'light dark mode appearance color catppuccin dracula tokyo night nord gruvbox github solarized monokai rose pine one dark', keys: ['t', '⌘⇧l'], run: openThemePicker },
  { id: 'reset-layout', section: 'Layout', title: 'Reset layout', aliases: 'panes widths default', keys: ['⌘⇧0'], run: () => layout.reset() },

  { id: 'next-pr', section: 'Navigate', title: 'Next pull request', keys: ['j', '↓'], run: () => movePull(1) },
  { id: 'prev-pr', section: 'Navigate', title: 'Previous pull request', keys: ['k', '↑'], run: () => movePull(-1) },
  { id: 'page-diff-down', section: 'Navigate', title: 'Page down (middle pane)', keys: ['space'], run: () => scrollPane('middle', 'page-down'), isEnabled: hasPull },
  { id: 'page-diff-up', section: 'Navigate', title: 'Page up (middle pane)', keys: ['⇧space'], run: () => scrollPane('middle', 'page-up'), isEnabled: hasPull },
  { id: 'list-first', section: 'Navigate', title: 'First pull request', aliases: 'vim top', keys: ['g g', 'Home'], run: () => jumpPull('first') },
  { id: 'list-last', section: 'Navigate', title: 'Last pull request', aliases: 'vim bottom', keys: ['⇧g', 'End'], run: () => jumpPull('last') },
  { id: 'next-file', section: 'Navigate', title: 'Next file', keys: ['n', ']c', '⌥↓'], run: () => moveFile(1), isEnabled: hasFiles },
  { id: 'prev-file', section: 'Navigate', title: 'Previous file', keys: ['[c', '⌥↑'], run: () => moveFile(-1), isEnabled: hasFiles },
  { id: 'preview', section: 'Pull request', title: 'Open preview deployment', aliases: 'preview deploy vercel netlify cloudflare pages staging site web', keys: ['p'], run: () => void openPreview(), isEnabled: hasPull },
  { id: 'media', section: 'Navigate', title: 'Open first image / video / HTML preview', aliases: 'lightbox screenshot media picture gif recording', keys: ['i', '⌘⇧i'], run: () => openMedia(0), isEnabled: hasPull },
  { id: 'description', section: 'Navigate', title: 'Jump to description', keys: ['⌘↑'], run: () => diffView.scrollToTop(), isEnabled: hasPull },
  { id: 'devin', section: 'Pull request', title: 'Open Devin session', aliases: 'devin agent session link', keys: ['d'], run: () => void openDevinSession(), isEnabled: hasPull },
  { id: 'fix-with-devin', section: 'Pull request', title: 'Fix CI / merge conflicts with Devin', aliases: 'conflict rebase devin resolve merge fix ci checks failing', keys: ['⇧f'], run: () => void fixWithDevin(), isEnabled: () => { const pull = selectedPull(); return pull != null && devinFixMessage(pull) != null; } },
  { id: 'message-devin', section: 'Pull request', title: 'Message Devin session', aliases: 'devin agent session send tell ask chat', keys: ['⇧d'], run: () => void openDevinMessageDialog(), isEnabled: hasPull },

  ...VIM_COMMANDS,
  ...DIFF_SCROLL_COMMANDS,
  { id: 'toggle-file', section: 'Diff', title: 'Collapse / expand file', aliases: 'fold unfold hide', keys: ['x'], run: toggleCurrentFile, isEnabled: hasFiles },
  { id: 'toggle-bots', section: 'Pull request', title: 'Show / hide bot comments', aliases: 'devin perry github-actions automated comments conversation', keys: ['⇧b'], run: () => { showBotComments = !showBotComments; localStorage.setItem('showBotComments', showBotComments ? '1' : '0'); const pull = selectedPull(); if (pull != null) renderDetail(pull); toast(showBotComments ? 'Showing bot comments' : 'Hiding bot comments'); } },
  { id: 'diff-style', section: 'Diff', title: 'Toggle split / unified diff', aliases: 'side by side inline view', keys: ['s', '⌘⌥s'], run: toggleStyle },

  { id: 'open-threads', section: 'Pull request', title: 'Jump to open review threads', aliases: 'unresolved comments threads review feedback resolve', keys: ['⇧c'], run: focusFirstOpenThread, isEnabled: hasPull },
  { id: 'comment', section: 'Pull request', title: 'Write a comment', aliases: 'reply message mention devin note', keys: ['c'], run: openCommentDialog, isEnabled: hasPull },
  { id: 'approve', section: 'Pull request', title: 'Approve', aliases: 'lgtm review accept', keys: ['a'], run: () => void approveSelected(), isEnabled: () => { const pull = selectedPull(); return pull != null && !isOwnPull(pull); } },
  { id: 'merge', section: 'Pull request', title: 'Merge (all selected when several are checked)', aliases: 'squash ship land queue', keys: ['⌘↵', 'm'], run: () => void (state.checkedIds.size > 0 ? bulkMerge() : mergeSelected()), isEnabled: () => hasPull() || state.checkedIds.size > 0 },
  { id: 'fix-prompt', section: 'Pull request', title: 'Needs attention → copy agent prompt', aliases: 'triage unapproved broken red failing ci conflict agent devin claude codex prompt clipboard review', keys: ['⇧x'], run: openTriage },
  { id: 'open', section: 'Pull request', title: 'Open on GitHub', aliases: 'browser link url web', keys: ['o', '⌘o', 'g o'], run: openSelectedOnGitHub, isEnabled: hasPull },
  { id: 'copy-url', section: 'Pull request', title: 'Copy link', keys: ['⌘⇧c', 'y'], run: () => { const pull = selectedPull(); if (pull != null) copyText(pull.url, 'link'); }, isEnabled: hasPull },
  { id: 'copy-branch', section: 'Pull request', title: 'Copy branch name', keys: ['⌘⇧.', 'b'], run: () => { const pull = selectedPull(); if (pull != null) copyText(pull.headRefName, 'branch'); }, isEnabled: hasPull },
];

const SEQUENCE_TIMEOUT_MS = 900;
const isSequenceShortcut = (shortcut: string): boolean => shortcut.includes(' ') || /^[[\]][a-z]$/.test(shortcut);
const sequenceCommands = COMMANDS.filter((command) => command.keys.some(isSequenceShortcut));
let pendingPrefix: string | null = null;
let prefixTimer: number | undefined;

commands.add(...COMMANDS.map((command) => ({ ...command, keys: command.keys.filter((shortcut) => !isSequenceShortcut(shortcut)) })));

const SEQUENCE_PREFIXES = new Set(['g', '[', ']']);

function handleSequence(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (pendingPrefix != null) {
    const shortcut = `${pendingPrefix} ${key}`;
    const bracketShortcut = `${pendingPrefix}${key}`;
    pendingPrefix = null;
    window.clearTimeout(prefixTimer);
    const command = sequenceCommands.find((candidate) => candidate.keys.includes(shortcut) || candidate.keys.includes(bracketShortcut));
    if (command == null) return false;
    event.preventDefault();
    command.run();
    return true;
  }
  if (!SEQUENCE_PREFIXES.has(key) || (event.shiftKey && key !== '[' && key !== ']')) return false;
  pendingPrefix = key;
  prefixTimer = window.setTimeout(() => (pendingPrefix = null), SEQUENCE_TIMEOUT_MS);
  event.preventDefault();
  return true;
}

document.addEventListener('keydown', (event) => {
  if ((event.isComposing && !event.altKey) || lightbox.isOpen || dom.confirm.open || dom.help.open || dom.bulkConfirm.open || dom.triage.open || themePicker.isOpen || dom.commentDialog.open) return;
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
  if (isTyping && (event.key === 'Escape' || (event.key === 'Enter' && !event.metaKey))) {
    if (event.key === 'Escape' && target === dom.filter && dom.filter.value !== '' && filteredPulls().length === 0) {
      dom.filter.value = '';
      dom.filter.dispatchEvent(new Event('input', { bubbles: true }));
    }
    (target as HTMLElement).blur();
    event.preventDefault();
    return;
  }
  if (!isTyping && handleSequence(event)) return;
  commands.handle(event, isTyping);
});

dom.list.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const selectAll = target.closest<HTMLElement>('[data-group-select]');
  if (selectAll != null) {
    const section = listSections(filteredPulls()).find((candidate) => candidate.group?.id === selectAll.dataset.groupSelect);
    if (section != null) setChecked(section.pulls.map((pull) => pull.id), true);
    return;
  }
  const header = target.closest<HTMLElement>('.group-row');
  if (header?.dataset.group != null) {
    const id = header.dataset.group;
    if (collapsedGroups.has(id)) collapsedGroups.delete(id);
    else collapsedGroups.add(id);
    invalidateList();
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    renderList();
    return;
  }
  const row = target.closest<HTMLElement>('li');
  const rowId = row?.dataset.id;
  if (rowId != null && (target.closest('.check-box') != null || event.metaKey || event.shiftKey)) {
    event.preventDefault();
    toggleChecked(rowId, event.shiftKey);
    return;
  }
  const id = rowId;
  const pull = state.pulls.find((candidate) => candidate.id === id);
  if (pull != null) void select(pull);
});

dom.files.addEventListener('click', (event) => {
  const index = Number((event.target as HTMLElement).closest<HTMLElement>('button')?.dataset.index);
  if (Number.isInteger(index)) setActiveFile(index);
});

document.getElementById('pr-body-split')?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const media = target.closest?.('.description img, .description video, .description a');
  if (media instanceof HTMLElement && openMediaFrom(media instanceof HTMLAnchorElement ? (media.querySelector('img') ?? media) : media)) {
    event.preventDefault();
    return;
  }
});

document.querySelectorAll<HTMLButtonElement>('.views button').forEach((button) =>
  button.addEventListener('click', () => switchKind(button.dataset.kind as QueueKind)),
);
let filterFrame = 0;
dom.filter.addEventListener('input', () => {
  state.filter = dom.filter.value;
  cancelAnimationFrame(filterFrame);
  filterFrame = requestAnimationFrame(() => {
    renderList();
    renderSearchState();
  });
  scheduleSemanticSearch();
});
element('toggle-sidebar').addEventListener('click', () => layout.toggle('list'));
element('open-help').addEventListener('click', openHelp);
element('open-github').addEventListener('click', openSelectedOnGitHub);
element('refresh-button').addEventListener('click', manualRefresh);
element('open-triage').addEventListener('click', openTriage);
wireFindBar();
element('pasted-order').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('.pasted-clear') != null) {
    setPastedOrder(null);
    toast('Back to the normal order');
  }
});
renderPastedChip();
element('list-empty').addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-empty-action]')?.dataset.emptyAction;
  if (action === 'clear-filter') {
    dom.filter.value = '';
    dom.filter.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (action === 'show-all') setSmartFilter('all');
});
document.querySelectorAll<HTMLElement>('.h-scroll').forEach(attachScrollFade);
animateDialogCancel();
watchKbdGlyphs();
element('theme-button').addEventListener('click', openThemePicker);
refreshTicker = window.setInterval(renderRefreshStatus, 5_000);
void refreshTicker;
dom.crumbs.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('.pr-link')) return;
  event.preventDefault();
  openSelectedOnGitHub();
});
applyReviewMode();
enableWindowDrag();
applyTheme();
enableTooltips();
routeLinksToBrowser(openInBrowser, (message) => toast(message, true));
systemDark.addEventListener('change', () => themeId === SYSTEM_THEME_ID && applyTheme());
dom.filterBar.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-smart]');
  if (chip != null) setSmartFilter(chip.dataset.smart as SmartFilter);
});
dom.sort.addEventListener('change', () => setSortOrder(dom.sort.value as SortOrder));
element('bulk-ready').addEventListener('click', selectReady);
element('bulk-unready').addEventListener('click', selectUnready);
element('bulk-clear').addEventListener('click', clearChecked);
dom.bulkApprove.addEventListener('click', () => void bulkApprove());
dom.bulkMerge.addEventListener('click', () => void bulkMerge());
syncPaneButtons();
dom.approve.addEventListener('click', () => void approveSelected());
dom.merge.addEventListener('click', () => void (state.checkedIds.size > 0 ? bulkMerge() : mergeSelected()));
window.addEventListener('focus', () => void refresh(state.kind));
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh(state.kind);
}, QUEUE_REFRESH_MS);

void fetchViewerLogin().then((login) => {
  viewer = login;
  const pull = selectedPull();
  if (pull != null) renderDetailMeta(pull);
  renderBulkBar();
});

void isReadinessAvailable().then((isAvailable) => {
  isAiEnabled = isAvailable;
  renderAiStatus();
  if (isAvailable) void scoreWithJev(state.pulls);
  if (isAvailable) void ensureGroups();
});

const checkForUpdates = startAutoUpdate({
  onReady: (version, restart) => {
    const pill = document.getElementById('update-pill');
    if (pill == null) return;
    pill.hidden = false;
    pill.dataset.tip = `PR Review ${version} is installed. Restart to use it  ⌘⇧U`;
    pill.onclick = restart;
    restartIntoUpdate = restart;
    toast(`Updated to ${version} · restart when ready (⌘⇧U)`);
  },
  onError: (message) => toast(`Update check failed: ${message}`, true),
});
let restartIntoUpdate: (() => void) | null = null;

renderBootSkeletons();
void refresh(state.kind, true).then(() => {
  (['mine', 'review', 'involved'] satisfies QueueKind[]).filter((kind) => kind !== state.kind).forEach((kind) => void refresh(kind, true));
});

if (import.meta.env.VITE_PR_REVIEW_HARNESS === '1') {
  Object.assign(window, {
    __prReview: {
      snapshot: () => ({
        selectedId: state.selectedId,
        checkedIds: [...state.checkedIds].sort(),
        visibleIds: visiblePulls().map((pull) => pull.id),
        smartFilter: state.smartFilter,
        filter: state.filter,
        isVisual: visualAnchorId != null,
        themeId,
        renderedRows: dom.list.querySelectorAll('li[data-id]').length,
      }),
    },
  });
}
