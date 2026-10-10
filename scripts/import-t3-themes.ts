// Generates src/themes-t3.ts from T3 Code's palette file (MIT, https://github.com/pingdotgg/t3code).
// Usage: bun scripts/import-t3-themes.ts /path/to/t3code/packages/shared/src/themePalettes.ts
import { join } from 'node:path';
import type { AppTheme, ThemeMode } from '../src/themes';

type Colors = Record<string, string>;
type Rgb = [number, number, number];

interface T3Theme {
  id: string;
  label: string;
  appearance: ThemeMode;
  colors: Colors;
  variants?: Partial<Record<ThemeMode, Colors>>;
}

interface T3Palettes {
  BUILT_IN_THEMES: readonly T3Theme[];
  T3_CODE_LIGHT_THEME_COLORS: Colors;
  T3_CODE_DARK_THEME_COLORS: Colors;
}

/** T3 Code leaves success unthemed: Tailwind emerald-500 on dark, emerald-600 on light. */
const SUCCESS: Record<ThemeMode, string> = { dark: '#10b981', light: '#059669' };
const DIFF_THEME: Record<ThemeMode, string> = { dark: 'pierre-dark', light: 'pierre-light' };

function oklchToOklab(l: number, c: number, h: number): Rgb {
  const radians = (h * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

function oklabToLinear([l, a, b]: Rgb): Rgb {
  const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((value) => value ** 3) as Rgb;
  const [x, y, z] = lms;
  return [4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z, -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z, -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z];
}

function linearToOklab([r, g, b]: Rgb): Rgb {
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt) as Rgb;
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

const toSrgb = (value: number): number => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
const fromSrgb = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** Parses `#rrggbb` or `oklch(l c h)` into OKLab. */
function parse(color: string): Rgb {
  const oklch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (oklch != null) return oklchToOklab(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex == null) throw new Error(`unsupported colour: ${color}`);
  const channels = [0, 2, 4].map((offset) => fromSrgb(parseInt(hex[1]!.slice(offset, offset + 2), 16) / 255)) as Rgb;
  return linearToOklab(channels);
}

function toHex(lab: Rgb): string {
  return `#${oklabToLinear(lab).map((channel) => Math.round(Math.min(1, Math.max(0, toSrgb(channel))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Mixes two colours in OKLab; `amount` is the share of `to`. */
function mix(from: string, to: string, amount: number): string {
  const [left, right] = [parse(from), parse(to)];
  return toHex(left.map((channel, index) => channel + (right[index]! - channel) * amount) as Rgb);
}

const hex = (color: string): string => toHex(parse(color));

function toAppTheme(id: string, name: string, mode: ThemeMode, colors: Colors): AppTheme {
  return {
    id,
    name,
    mode,
    diff: DIFF_THEME[mode],
    accentFg: hex(colors.accentForeground!),
    colors: {
      bg: hex(colors.canvas!),
      bgElev: hex(colors.toolbarControl!),
      bgHover: hex(colors.toolbarControlHover!),
      bgActive: mix(colors.toolbarControlHover!, colors.text!, 0.06),
      border: hex(colors.border!),
      borderSoft: mix(colors.border!, colors.canvas!, 0.5),
      text: hex(colors.text!),
      text2: mix(colors.text!, colors.textMuted!, 0.3),
      text3: hex(colors.textMuted!),
      text4: mix(colors.textMuted!, colors.canvas!, 0.35),
      accent: hex(colors.accent!),
      ok: SUCCESS[mode],
      bad: hex(colors.error!),
      wait: hex(colors.warning!),
    },
  };
}

const MODE_SUFFIX: Record<ThemeMode, string> = { dark: 'Dark', light: 'Light' };

function variantsOf(theme: T3Theme): AppTheme[] {
  return (['dark', 'light'] as const).flatMap((mode) => {
    const colors = theme.appearance === mode ? theme.colors : theme.variants?.[mode];
    return colors == null ? [] : [toAppTheme(`t3-${theme.id.replace(/^t3-/, '')}-${mode}`, `${theme.label} ${MODE_SUFFIX[mode]}`, mode, colors)];
  });
}

const source = process.argv[2];
if (source == null) throw new Error('usage: bun scripts/import-t3-themes.ts <t3code>/packages/shared/src/themePalettes.ts');
const palettes = (await import(source)) as T3Palettes;
const themes = [
  toAppTheme('t3-code-dark', 'T3 Code Dark', 'dark', palettes.T3_CODE_DARK_THEME_COLORS),
  toAppTheme('t3-code-light', 'T3 Code Light', 'light', palettes.T3_CODE_LIGHT_THEME_COLORS),
  ...palettes.BUILT_IN_THEMES.flatMap(variantsOf),
];
const literal = (value: unknown): string => (typeof value === 'object' && value != null ? `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${literal(entry)}`).join(', ')} }` : `'${String(value)}'`);
const body = themes.map((theme) => `  ${literal(theme)},`).join('\n');
const output = `// Generated by scripts/import-t3-themes.ts from T3 Code's palettes. Do not edit by hand.
// T3 Code: https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3 Tools Inc.
import type { AppTheme } from './themes';

export const T3_THEMES: readonly AppTheme[] = [
${body}
];
`;
await Bun.write(join(import.meta.dir, '..', 'src', 'themes-t3.ts'), output);
console.log(`wrote ${themes.length} themes to src/themes-t3.ts`);
