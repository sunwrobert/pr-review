export interface Command {
  id: string;
  allowWhileTyping?: boolean;
  title: string;
  section: string;
  keys: string[];
  aliases?: string;
  run(): void;
  isEnabled?(): boolean;
}

interface Chord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const KEY_ALIASES: Record<string, string> = { '⌫': 'Backspace', '↵': 'Enter', '↑': 'ArrowUp', '↓': 'ArrowDown', esc: 'Escape', space: ' ', Home: 'Home', End: 'End' };

const MODIFIER_PATTERN = /[⌘⌃⇧⌥]/g;

function parseChord(shortcut: string): Chord {
  const parts = [...shortcut];
  const key = shortcut.replace(MODIFIER_PATTERN, '');
  return { key: KEY_ALIASES[key] ?? key, meta: parts.includes('⌘'), ctrl: parts.includes('⌃'), shift: parts.includes('⇧'), alt: parts.includes('⌥') };
}

function eventKey(event: KeyboardEvent): string {
  if (event.code.startsWith('Key')) return event.code.slice(3).toLowerCase();
  if (event.key === 'Dead' && event.code === '') return '';
  if (event.code.startsWith('Digit')) return event.code.slice(5);
  if (event.code === 'Backslash') return '\\';
  if (event.code === 'Period') return '.';
  if (event.code === 'Slash') return event.shiftKey && !event.metaKey ? '?' : '/';
  if (event.code === 'BracketLeft') return '[';
  if (event.code === 'BracketRight') return ']';
  if (event.code === 'Comma') return ',';
  if (event.code === 'Minus') return '-';
  if (event.code === 'Semicolon') return ';';
  return event.key;
}

function matches(chord: Chord, event: KeyboardEvent): boolean {
  const key = eventKey(event);
  const isQuestionMark = chord.key === '?' && key === '?';
  if (chord.meta !== event.metaKey || chord.ctrl !== event.ctrlKey || chord.alt !== event.altKey) return false;
  if (!isQuestionMark && chord.shift !== event.shiftKey) return false;
  return key.toLowerCase() === chord.key.toLowerCase();
}

function splitShortcut(shortcut: string): string[] {
  const modifiers = [...shortcut].filter((character) => '⌃⌥⇧⌘'.includes(character)).sort((left, right) => '⌃⌥⇧⌘'.indexOf(left) - '⌃⌥⇧⌘'.indexOf(right));
  const key = shortcut.replace(MODIFIER_PATTERN, '');
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key];
}

export function renderShortcut(shortcut: string): string {
  if (/^[[\]][a-z]$/.test(shortcut)) return [...shortcut].map((part) => `<kbd>${part}</kbd>`).join('');
  if (shortcut.includes(' ')) return shortcut.split(' ').map((part) => `<kbd>${part.toUpperCase()}</kbd>`).join('<span class="then">then</span>');
  return splitShortcut(shortcut).map((part) => `<kbd>${part}</kbd>`).join('');
}

export function renderKeys(keys: readonly string[]): string {
  const [first] = keys;
  return first == null ? '' : renderShortcut(first);
}

const TEXT_EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete']);

function isTextEditingChord(event: KeyboardEvent): boolean {
  return event.metaKey && TEXT_EDITING_KEYS.has(eventKey(event).toLowerCase());
}

export class CommandRegistry {
  private readonly commands: Command[] = [];
  private readonly chords = new Map<Command, Chord[]>();

  add(...commands: Command[]): void {
    commands.forEach((command) => {
      this.commands.push(command);
      this.chords.set(command, command.keys.map(parseChord));
    });
  }

  list(): readonly Command[] {
    return this.commands;
  }

  handle(event: KeyboardEvent, isTyping: boolean): boolean {
    if (isTyping && isTextEditingChord(event)) return false;
    if (event.key === 'Shift' || event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.repeat === false && event.key === 'CapsLock') return false;
    const command = this.commands.find((candidate) => {
      if (isTyping && candidate.allowWhileTyping !== true) return false;
      return (this.chords.get(candidate) ?? []).some((chord) => matches(chord, event) && (!isTyping || chord.meta || chord.ctrl));
    });
    if (command == null || command.isEnabled?.() === false) return false;
    event.preventDefault();
    command.run();
    return true;
  }
}
