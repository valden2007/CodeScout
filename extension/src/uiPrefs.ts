export type UiTheme = 'auto' | 'dark' | 'light' | 'custom';
export type ReportTheme = 'auto' | 'dark' | 'light';
export type AccentColor = 'auto' | 'blue' | 'purple' | 'green' | 'orange' | 'pink';
export type UiDensity = 'compact' | 'standard';
export type UiFontSize = 's' | 'm' | 'l';
export type FindingsSort = 'severity' | 'file' | 'line';

export interface CustomColors {
  bg: string;
  card: string;
  fg: string;
  desc: string;
  border: string;
  accent: string;
  inputBg: string;
  inputFg: string;
  btnBg: string;
  btnFg: string;
  btnHover: string;
  error: string;
  warn: string;
  pass: string;
  chipBg: string;
  chipFg: string;
  btnRadius: number;
  btnHeight: number;
  cardRadius: number;
}

export const DEFAULT_CUSTOM_COLORS: CustomColors = {
  bg: '#f5f5f5',
  card: '#ffffff',
  fg: '#1f2326',
  desc: '#5a6068',
  border: '#d0d3d6',
  accent: '#0a64b4',
  inputBg: '#ffffff',
  inputFg: '#1f2326',
  btnBg: '#0067b8',
  btnFg: '#ffffff',
  btnHover: '#0279d3',
  error: '#c72e2e',
  warn: '#8a6d00',
  pass: '#0b6cba',
  chipBg: '#e6e8ea',
  chipFg: '#1f2326',
  btnRadius: 4,
  btnHeight: 30,
  cardRadius: 6
};

type ColorKey = 'bg' | 'card' | 'fg' | 'desc' | 'border' | 'accent' | 'inputBg' | 'inputFg' | 'btnBg' | 'btnFg' | 'btnHover' | 'error' | 'warn' | 'pass' | 'chipBg' | 'chipFg';
type GeometryKey = 'btnRadius' | 'btnHeight' | 'cardRadius';
const COLOR_KEYS: ColorKey[] = ['bg', 'card', 'fg', 'desc', 'border', 'accent', 'inputBg', 'inputFg', 'btnBg', 'btnFg', 'btnHover', 'error', 'warn', 'pass', 'chipBg', 'chipFg'];
const GEOMETRY_LIMITS: Record<GeometryKey, [number, number]> = {
  btnRadius: [2, 12],
  btnHeight: [24, 40],
  cardRadius: [0, 16]
};
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normalizeCustomColors(input: unknown): CustomColors {
  let obj: Record<string, unknown> = {};
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch {
      obj = {};
    }
  } else if (input && typeof input === 'object') {
    obj = input as Record<string, unknown>;
  }
  const result = { ...DEFAULT_CUSTOM_COLORS };
  for (const key of COLOR_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && HEX_RE.test(value.trim())) result[key] = value.trim().toLowerCase();
  }
  for (const key of Object.keys(GEOMETRY_LIMITS) as GeometryKey[]) {
    const value = Number(obj[key]);
    const [min, max] = GEOMETRY_LIMITS[key];
    if (Number.isFinite(value)) result[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return result;
}

export interface UiPrefs {
  theme: UiTheme;
  accent: AccentColor;
  density: UiDensity;
  fontSize: UiFontSize;
  showConfidence: boolean;
  findingsSort: FindingsSort;
  reportTheme: ReportTheme;
  customColors: CustomColors;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: 'auto',
  accent: 'auto',
  density: 'standard',
  fontSize: 'm',
  showConfidence: true,
  findingsSort: 'severity',
  reportTheme: 'auto',
  customColors: { ...DEFAULT_CUSTOM_COLORS }
};

const THEME_VALUES: UiTheme[] = ['auto', 'dark', 'light', 'custom'];
// reportTheme — тема экспортируемого отчёта: custom у неё смысла нет
// (в манифесте и в селекте центра только auto|dark|light).
const REPORT_THEME_VALUES: ReportTheme[] = ['auto', 'dark', 'light'];
const ACCENT_VALUES: AccentColor[] = ['auto', 'blue', 'purple', 'green', 'orange', 'pink'];
const DENSITY_VALUES: UiDensity[] = ['compact', 'standard'];
const FONTSIZE_VALUES: UiFontSize[] = ['s', 'm', 'l'];
const SORT_VALUES: FindingsSort[] = ['severity', 'file', 'line'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export type UiPrefsInput = Partial<Omit<UiPrefs, 'customColors'>> & { customColors?: unknown };

export function normalizeUiPrefs(input: UiPrefsInput | undefined): UiPrefs {
  const p = input ?? {};
  return {
    theme: pick(p.theme, THEME_VALUES, DEFAULT_UI_PREFS.theme),
    accent: pick(p.accent, ACCENT_VALUES, DEFAULT_UI_PREFS.accent),
    density: pick(p.density, DENSITY_VALUES, DEFAULT_UI_PREFS.density),
    fontSize: pick(p.fontSize, FONTSIZE_VALUES, DEFAULT_UI_PREFS.fontSize),
    showConfidence: p.showConfidence !== false,
    findingsSort: pick(p.findingsSort, SORT_VALUES, DEFAULT_UI_PREFS.findingsSort),
    reportTheme: pick(p.reportTheme, REPORT_THEME_VALUES, DEFAULT_UI_PREFS.reportTheme),
    customColors: normalizeCustomColors(p.customColors)
  };
}

// Пользовательская палитра → токены страниц. border/input* расходятся на
// производные; геометрия правит радиусы/высоту кнопок и карточек.
export function customVarsStyle(colors: CustomColors): string {
  const c = normalizeCustomColors(colors);
  return [
    `--cs-editor-bg: ${c.bg}`,
    `--cs-card-bg: ${c.card}`,
    `--cs-fg: ${c.fg}`,
    `--cs-desc: ${c.desc}`,
    `--cs-border: ${c.border}`,
    `--cs-card-border: ${c.border}`,
    `--cs-input-border: ${c.border}`,
    `--cs-accent: ${c.accent}`,
    `--cs-input-bg: ${c.inputBg}`,
    `--cs-select-bg: ${c.inputBg}`,
    `--cs-input-fg: ${c.inputFg}`,
    `--cs-select-fg: ${c.inputFg}`,
    `--cs-btn-bg: ${c.btnBg}`,
    `--cs-btn-fg: ${c.btnFg}`,
    `--cs-btn-hover: ${c.btnHover}`,
    `--cs-error: ${c.error}`,
    `--cs-warn: ${c.warn}`,
    `--cs-pass: ${c.pass}`,
    `--cs-chip-bg: ${c.chipBg}`,
    `--cs-chip-fg: ${c.chipFg}`,
    `--cs-radius-btn: ${c.btnRadius}px`,
    `--cs-btn-height: ${c.btnHeight}px`,
    `--cs-radius-card: ${c.cardRadius}px`
  ].join('; ');
}

export function uiBodyAttrs(prefs: UiPrefsInput): string {
  const p = normalizeUiPrefs(prefs);
  const base = `data-theme="${p.theme}" data-density="${p.density}" data-fontsize="${p.fontSize}" data-accent="${p.accent}" data-report-theme="${p.reportTheme}"`;
  if (p.theme !== 'custom') return base;
  return `${base} style="${customVarsStyle(p.customColors)}"`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(fg: string, bg: string): number {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!a || !b) return 1;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isLowContrast(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) < 4.5;
}

// Базовые токены (режим auto): цвета ТОЛЬКО из --vscode-* — наследуют тему VS Code.
// Контролы страниц ссылаются на --cs-*, а не на --vscode-* напрямую,
// поэтому forced-тема light/dark переопределяет токены, а не фоны.
export const CS_BASE_TOKENS = `:root {
  --cs-space-1: 4px; --cs-space-2: 8px; --cs-space-3: 12px; --cs-space-4: 16px;
  --cs-radius-1: 4px; --cs-radius-2: 6px;
  --cs-radius-btn: 4px; --cs-radius-card: 6px; --cs-btn-height: 30px;
  --cs-font-1: 11px; --cs-font-2: 12px; --cs-font-3: 13px; --cs-font-4: 15px;
  --cs-fg: var(--vscode-foreground);
  --cs-desc: var(--vscode-descriptionForeground);
  --cs-border: var(--vscode-panel-border);
  --cs-input-border: var(--vscode-input-border, var(--vscode-panel-border));
  --cs-input-bg: var(--vscode-input-background);
  --cs-input-fg: var(--vscode-input-foreground);
  --cs-select-bg: var(--vscode-input-background);
  --cs-select-fg: var(--vscode-input-foreground);
  --cs-checkbox: var(--vscode-checkbox-background, var(--vscode-input-background));
  --cs-chip-bg: var(--vscode-badge-background);
  --cs-chip-fg: var(--vscode-badge-foreground);
  --cs-card-bg: var(--vscode-editor-background);
  --cs-card-border: var(--vscode-panel-border);
  --cs-shadow: none;
  --cs-list-hover: var(--vscode-list-hoverBackground);
  --cs-btn-bg: var(--vscode-button-background);
  --cs-btn-fg: var(--vscode-button-foreground);
  --cs-btn-hover: var(--vscode-button-hoverBackground);
  --cs-btn2-bg: var(--vscode-button-secondaryBackground);
  --cs-btn2-fg: var(--vscode-button-secondaryForeground);
  --cs-btn2-hover: var(--vscode-button-secondaryHoverBackground);
  --cs-accent: var(--vscode-textLink-foreground);
  --cs-error: var(--vscode-errorForeground);
  --cs-warn: var(--vscode-editorWarning-foreground);
  --cs-pass: var(--vscode-testing-iconPassed);
  --cs-code-bg: var(--vscode-textCodeBlock-background);
  --cs-editor-bg: var(--vscode-editor-background);
}`;

// Палитра dark/light и акценты — единственное место, где допустимы #hex
// (фиксированная тема наших страниц, когда пользователь выбрал не auto).
// Контракт «нет #hex» действует вне блока cs-theme-palette.
const CS_THEME_PALETTE = `
/* cs-theme-palette:start */
body[data-theme="dark"] {
  --cs-fg: #d7dade; --cs-desc: #9aa0a6; --cs-border: #3a3d41; --cs-input-border: #3a3d41;
  --cs-input-bg: #3b3d41; --cs-input-fg: #e7e9ea; --cs-select-bg: #3b3d41; --cs-select-fg: #e7e9ea;
  --cs-checkbox: #3b3d41; --cs-chip-bg: #3a3d41; --cs-chip-fg: #d7dade;
  --cs-card-bg: #25262b; --cs-card-border: #3a3d41; --cs-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); --cs-list-hover: #2a2d2e;
  --cs-btn-bg: #0e639c; --cs-btn-fg: #ffffff; --cs-btn-hover: #1177bb;
  --cs-btn2-bg: #3a3d41; --cs-btn2-fg: #d7dade; --cs-btn2-hover: #4a4e54;
  --cs-accent: #4fa1de; --cs-error: #f14c4c; --cs-warn: #cca700; --cs-pass: #75beff;
  --cs-code-bg: #1b1d21; --cs-editor-bg: #1e1f22;
}
body[data-theme="light"] {
  --cs-fg: #1f2326; --cs-desc: #5a6068; --cs-border: #d0d3d6; --cs-input-border: #b9bcc0;
  --cs-input-bg: #ffffff; --cs-input-fg: #1f2326; --cs-select-bg: #ffffff; --cs-select-fg: #1f2326;
  --cs-checkbox: #ffffff; --cs-chip-bg: #e6e8ea; --cs-chip-fg: #1f2326;
  --cs-card-bg: #ffffff; --cs-card-border: #d0d3d6; --cs-shadow: 0 1px 3px rgba(15, 20, 25, 0.14); --cs-list-hover: #e8eaec;
  --cs-btn-bg: #0067b8; --cs-btn-fg: #ffffff; --cs-btn-hover: #0279d3;
  --cs-btn2-bg: #e4e6e9; --cs-btn2-fg: #1f2326; --cs-btn2-hover: #d4d7db;
  --cs-accent: #0a64b4; --cs-error: #c72e2e; --cs-warn: #8a6d00; --cs-pass: #0b6cba;
  --cs-code-bg: #f2f3f4; --cs-editor-bg: #f5f5f5;
}
body[data-accent="blue"] { --cs-accent: #3b82f6; }
body[data-accent="purple"] { --cs-accent: #8b5cf6; }
body[data-accent="green"] { --cs-accent: #22a06b; }
body[data-accent="orange"] { --cs-accent: #e07b39; }
body[data-accent="pink"] { --cs-accent: #db4d8f; }
/* cs-theme-palette:end */
`;

const CS_DENSITY = `
body[data-density="compact"] { --cs-space-1: 3px; --cs-space-2: 6px; --cs-space-3: 9px; --cs-space-4: 12px; }
`;

const CS_FONTSIZE = `
body[data-fontsize="s"] { --cs-font-1: 10px; --cs-font-2: 11px; --cs-font-3: 12px; --cs-font-4: 14px; }
body[data-fontsize="l"] { --cs-font-1: 12px; --cs-font-2: 13px; --cs-font-3: 15px; --cs-font-4: 17px; }
`;

export function uiTokensCss(): string {
  return `${CS_BASE_TOKENS}\n${CS_THEME_PALETTE}\n${CS_DENSITY}\n${CS_FONTSIZE}`;
}
