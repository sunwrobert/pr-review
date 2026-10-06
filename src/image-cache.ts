const MAX_CACHED = 400;
const CONCURRENCY = 6;

const cache = new Map<string, HTMLImageElement>();
const queue: string[] = [];
let active = 0;

function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const url = queue.shift();
    if (url == null || cache.has(url)) continue;
    const image = new Image();
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    cache.set(url, image);
    active += 1;
    const done = (): void => {
      active -= 1;
      pump();
    };
    image.onload = () => {
      void image.decode().catch(() => undefined).finally(done);
    };
    image.onerror = () => {
      cache.delete(url);
      done();
    };
    image.src = url;
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? '');
  }
}

export function preloadImages(urls: readonly string[], isPriority = false): void {
  const fresh = urls.filter((url) => url.startsWith('https://') && !cache.has(url) && !queue.includes(url));
  if (isPriority) queue.unshift(...fresh);
  else queue.push(...fresh);
  pump();
}

export function imageUrlsInHtml(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="(https:[^"]+)"/gi)) {
    const url = match[1]?.replace(/&amp;/g, '&');
    if (url != null) urls.add(url);
  }
  return [...urls];
}

/** Swaps freshly parsed <img> nodes for already-decoded ones with the same src, so rebuilt markup doesn't flash blank. */
export function adoptImages(previous: Iterable<Element>, next: Iterable<Element>): void {
  const pool = new Map<string, HTMLImageElement[]>();
  for (const root of previous) {
    for (const image of root.matches('img') ? [root as HTMLImageElement] : root.querySelectorAll('img')) {
      if (!image.complete || image.naturalWidth === 0) continue;
      const list = pool.get(image.src) ?? [];
      list.push(image);
      pool.set(image.src, list);
    }
  }
  if (pool.size === 0) return;
  for (const root of next) {
    for (const image of root.matches('img') ? [root as HTMLImageElement] : [...root.querySelectorAll('img')]) {
      const kept = pool.get(image.src)?.shift();
      if (kept == null || kept === image) continue;
      for (const name of image.getAttributeNames()) if (name !== 'src' && kept.getAttribute(name) !== image.getAttribute(name)) kept.setAttribute(name, image.getAttribute(name) ?? '');
      image.replaceWith(kept);
    }
  }
}
