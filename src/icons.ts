// Icons from Lucide v0.469.0 (https://lucide.dev), ISC license. Vendored so the app never fetches at runtime.

const PATHS = {
  search: '<circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />',
  merge: '<circle cx="18" cy="18" r="3" /> <circle cx="6" cy="6" r="3" /> <path d="M6 21V9a9 9 0 0 0 9 9" />',
  send: '<path d="M14.5 21.7a.5.5 0 0 0 .9 0L22 3.5a.5.5 0 0 0-.6-.6L3.3 9.5a.5.5 0 0 0 0 .9l7.6 3.1a2 2 0 0 1 1.1 1.1z" /> <path d="m21.9 2.1-11 11" />',
  conflict: '<path d="m21.7 16.5-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 19.5h16a2 2 0 0 0 1.7-3z" /> <path d="M12 9v4" /> <path d="M12 16.5h.01" />',
  threads: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /> <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /> <path d="M9 18c-4.51 2-5-2-7-2" />',
  preview: '<rect x="2" y="4" width="20" height="16" rx="2" /> <path d="M10 4v4" /> <path d="M2 8h20" /> <path d="M6 4v4" />',
  theme: '<circle cx="12" cy="12" r="10" /> <path d="M12 18a6 6 0 0 0 0-12v12z" />',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /> <path d="M21 3v5h-5" /> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /> <path d="M8 16H3v5" />',
  menu: '<line x1="4" x2="20" y1="12" y2="12" /> <line x1="4" x2="20" y1="6" y2="6" /> <line x1="4" x2="20" y1="18" y2="18" />',
  keyboard: '<path d="M10 8h.01" /> <path d="M12 12h.01" /> <path d="M14 8h.01" /> <path d="M16 12h.01" /> <path d="M18 8h.01" /> <path d="M6 8h.01" /> <path d="M7 16h10" /> <path d="M8 12h.01" /> <rect width="20" height="16" x="2" y="4" rx="2" />',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M9 3v18" />',
  group: '<path d="m16.02 12 5.48 3.13a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74L7.98 12" /> <path d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74Z" />',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /> <path d="M20 3v4" /> <path d="M22 5h-4" /> <path d="M4 17v2" /> <path d="M5 18H3" />',
  chevronRight: '<path d="m9 18 6-6-6-6" />',
  chevronLeft: '<path d="m15 18-6-6 6-6" />',
  x: '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56" />',
  circleCheck: '<circle cx="12" cy="12" r="10" /> <path d="m9 12 2 2 4-4" />',
  circleX: '<circle cx="12" cy="12" r="10" /> <path d="m15 9-6 6" /> <path d="m9 9 6 6" />',
  circleAlert: '<circle cx="12" cy="12" r="10" /> <line x1="12" x2="12" y1="8" y2="12" /> <line x1="12" x2="12.01" y1="16" y2="16" />',
  circleDashed: '<path d="M10.1 2.182a10 10 0 0 1 3.8 0" /> <path d="M13.9 21.818a10 10 0 0 1-3.8 0" /> <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /> <path d="M2.182 13.9a10 10 0 0 1 0-3.8" /> <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /> <path d="M21.818 10.1a10 10 0 0 1 0 3.8" /> <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /> <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />',
  info: '<circle cx="12" cy="12" r="10" /> <path d="M12 16v-4" /> <path d="M12 8h.01" />',
} as const;

export type IconName = keyof typeof PATHS;

/** One renderer for every UI icon: 24px grid, 2px stroke, sized by CSS. */
export function icon(name: IconName, className = ''): string {
  return `<svg class="ico${className === '' ? '' : ` ${className}`}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** Replaces every `<i data-icon="name">` placeholder in static markup. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((placeholder) => {
    const name = placeholder.dataset.icon as IconName;
    if (!(name in PATHS)) return;
    placeholder.outerHTML = icon(name, placeholder.className);
  });
}
