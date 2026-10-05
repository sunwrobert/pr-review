const SHOW_DELAY_MS = 350;
const SHORTCUT_PATTERN = /\s{2,}(\S.*)$/;

function renderLabel(text: string): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const match = text.match(SHORTCUT_PATTERN);
  if (match == null) return `<span>${escape(text)}</span>`;
  const label = text.slice(0, match.index).trim();
  const keys = (match[1] ?? '')
    .split(/\s*\/\s*/)
    .map((combo) => [...combo.replace(/\s+/g, '')].map((key) => `<kbd>${escape(key)}</kbd>`).join(''))
    .join('<span class="tip-or">/</span>');
  return `<span>${escape(label)}</span><span class="tip-keys">${keys}</span>`;
}

function requestIdleCallbackSafe(callback: () => void): void {
  const idle = (window as unknown as { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle != null) idle(callback, { timeout: 200 });
  else window.setTimeout(callback, 50);
}

export function enableTooltips(): void {
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.popover = 'manual';
  document.body.append(tip);
  let timer = 0;
  let current: HTMLElement | null = null;

  const raiseAboveDialogs = (): void => {
    if (tip.matches(':popover-open')) tip.hidePopover();
    tip.showPopover();
  };

  const hide = (): void => {
    window.clearTimeout(timer);
    tip.classList.remove('show');
    current = null;
  };

  const show = (target: HTMLElement): void => {
    const text = target.dataset.tip ?? '';
    if (text === '') return;
    tip.innerHTML = renderLabel(text);
    tip.classList.remove('show');
    raiseAboveDialogs();
    tip.style.transition = 'none';
    const rect = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const below = rect.bottom + 8 + height < window.innerHeight;
    const top = below ? rect.bottom + 8 : rect.top - height - 8;
    const triggerCenter = rect.left + rect.width / 2;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, triggerCenter - width / 2));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.transformOrigin = `${Math.round(triggerCenter - left)}px ${below ? '0' : '100%'}`;
    tip.dataset.side = below ? 'below' : 'above';
    void tip.offsetWidth;
    tip.style.transition = '';
    tip.classList.add('show');
  };

  const adopt = (element: HTMLElement): void => {
    const title = element.getAttribute('title');
    if (title == null || title === '') return;
    element.dataset.tip = title;
    element.removeAttribute('title');
    if (!element.hasAttribute('aria-label') && element.textContent?.trim() === '') element.setAttribute('aria-label', title.replace(SHORTCUT_PATTERN, '').trim());
  };

  document.querySelectorAll<HTMLElement>('[title]').forEach(adopt);
  let pending: HTMLElement[] = [];
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    batch.forEach((node) => {
      if (!node.isConnected) return;
      adopt(node);
      node.querySelectorAll<HTMLElement>('[title]').forEach(adopt);
    });
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) adopt(mutation.target);
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) pending.push(node);
      });
    }
    if (pending.length > 0 && !scheduled) {
      scheduled = true;
      requestIdleCallbackSafe(flush);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', (event) => {
    const hovered = event.target as HTMLElement;
    if (hovered.hasAttribute?.('title')) adopt(hovered);
    const target = hovered.closest<HTMLElement>('[data-tip], [title]');
    if (target?.hasAttribute('title')) adopt(target);
    if (target === current) return;
    hide();
    if (target == null || document.body.classList.contains('resizing')) return;
    current = target;
    timer = window.setTimeout(() => current === target && show(target), SHOW_DELAY_MS);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('scroll', hide, true);
}
