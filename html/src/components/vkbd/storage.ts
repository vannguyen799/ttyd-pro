import type { KeyDef } from './types';
import { parseRoute } from '../tabs/model';

const STORAGE_KEY = 'ttyd.vkbd.v1';

// Synthetic group that holds custom buttons not routed into a built-in
// group. It's a valid target in the custom-button form and a valid entry
// in disabledGroups, but it is not part of GROUPS in keys.ts.
export const CUSTOM_GROUP_ID = 'custom';

// A stored custom button. `group` is the id of the group it renders under
// (a GROUPS id or CUSTOM_GROUP_ID); missing/unknown falls back to custom.
export type CustomKey = KeyDef & { id: string; group?: string };

export interface Settings {
    visible: boolean;
    position: 'bottom' | 'top';
    opacity: number;
    disabledIds: string[];
    // Group ids (GROUPS / CUSTOM_GROUP_ID) hidden as a whole.
    disabledGroups: string[];
    custom: CustomKey[];
    pos: { x: number; y: number } | null;
    width: number | null;
    keyHeight: number | null;
    // Proportional key-size multiplier (font, padding, height). 1 = default.
    scale: number;
    scrollStep: number;
    autoRepeat: boolean;
    repeatDelayMs: number;
    repeatIntervalMs: number;
    showInput: boolean;
    // Render a small caption above each group's rows.
    showGroupLabels: boolean;
    // Render the tiny sub-label (hint) under each key's main label.
    showKeySub: boolean;
    termFontSize: number | null;
}

function isCoarse(): boolean {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch {
        return false;
    }
}

function defaultVisible(): boolean {
    return isCoarse();
}

// On desktop (fine pointer) a physical keyboard already covers these
// groups, so seed them disabled and show only the value-add macro groups
// (Claude/Codex/tmux) when the bar is opened. Touch devices get every
// group. This only seeds the initial disabledGroups — users can re-enable
// any of them from settings, and a stored config overrides this entirely.
const DESKTOP_REDUNDANT_GROUPS = ['keys', 'edit', 'fn'];

function defaultDisabledGroups(): string[] {
    return isCoarse() ? [] : DESKTOP_REDUNDANT_GROUPS.slice();
}

function defaultFloating(): { pos: { x: number; y: number }; width: number } {
    try {
        const w = Math.min(window.innerWidth - 24, 520);
        const x = Math.max(12, Math.round((window.innerWidth - w) / 2));
        const estH = 200;
        const y = Math.max(12, window.innerHeight - estH - 24);
        return { pos: { x, y }, width: w };
    } catch {
        return { pos: { x: 24, y: 24 }, width: 400 };
    }
}

const DEFAULTS_STATIC: Omit<Settings, 'visible' | 'pos' | 'width' | 'disabledGroups'> = {
    position: 'bottom',
    opacity: 0.18,
    disabledIds: [],
    custom: [],
    keyHeight: null,
    scale: 1,
    scrollStep: 5,
    autoRepeat: true,
    repeatDelayMs: 350,
    repeatIntervalMs: 60,
    showInput: true,
    showGroupLabels: false,
    showKeySub: true,
    termFontSize: null,
};

// Stable per-key id. Keyed by group id (not array position) so reordering
// groups doesn't silently re-enable keys the user had disabled.
export function keyId(groupId: string, rowIndex: number, keyIndex: number, def: KeyDef): string {
    return `b:${groupId}:${rowIndex}:${keyIndex}:${def.label}`;
}

export function loadSettings(): Settings {
    const coarse = isCoarse();
    const fd = defaultFloating();
    const base: Settings = {
        ...DEFAULTS_STATIC,
        disabledGroups: defaultDisabledGroups(),
        visible: defaultVisible(),
        // Mobile-first default: dock at bottom (split screen with terminal).
        // Desktop default: float in center-bottom.
        pos: coarse ? null : fd.pos,
        width: coarse ? null : fd.width,
    };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return applyUrlOverride(base);
        const parsed = JSON.parse(raw);
        return applyUrlOverride({ ...base, ...parsed });
    } catch {
        return applyUrlOverride(base);
    }
}

export function resetLayout(current: Settings): Settings {
    const coarse = isCoarse();
    if (coarse) {
        return { ...current, pos: null, width: null, keyHeight: null };
    }
    const fd = defaultFloating();
    return { ...current, pos: fd.pos, width: fd.width, keyHeight: null };
}

function applyUrlOverride(s: Settings): Settings {
    try {
        const arg = new URLSearchParams(window.location.search).get('vkbd');
        if (arg === '1' || arg === 'true') return { ...s, visible: true };
        if (arg === '0' || arg === 'false') return { ...s, visible: false };
    } catch {
        // ignore
    }
    return s;
}

export function saveSettings(s: Settings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
        console.warn('[ttyd] vkbd save failed', e);
    }
}

export function genId(): string {
    return `c:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function ttydSessionName(): string {
    // With multiple tabs the active tab's session is published to a global by
    // App (window.ttydSession); it wins over the page URL so per-session input
    // history/drafts and the label follow the active tab. Falls back to the URL
    // for the single-terminal / no-tabs case. The URL fallback goes through the
    // same parseRoute() the tab model uses, so it can never disagree with what
    // ttyd-session.sh actually attaches to.
    try {
        const active = (window as unknown as { ttydSession?: string }).ttydSession;
        if (typeof active === 'string' && active) return active;
    } catch {
        // ignore
    }
    return parseRoute(window.location.search).session;
}

// Which multiplexer the ttyd wrapper (ttyd-session.sh) routes this tab to.
// tmux is the default backend; only an explicit `screen` arg switches it.
export function ttydSessionBackend(): 'tmux' | 'screen' {
    try {
        const active = (window as unknown as { ttydBackend?: 'tmux' | 'screen' }).ttydBackend;
        if (active === 'tmux' || active === 'screen') return active;
    } catch {
        // ignore
    }
    return parseRoute(window.location.search).backend;
}

function sessionKey(prefix: string): string {
    return `${prefix}:${ttydSessionName()}`;
}

function inputKey(): string {
    return sessionKey('ttyd.vkbd.input.v1');
}

const MAX_HISTORY = 10;

export function loadInputHistory(): string[] {
    try {
        const raw = localStorage.getItem(sessionKey('ttyd.vkbd.hist.v1'));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function pushInputHistory(text: string): void {
    if (!text.trim()) return;
    try {
        const k = sessionKey('ttyd.vkbd.hist.v1');
        const hist = loadInputHistory().filter(s => s !== text);
        hist.unshift(text);
        localStorage.setItem(k, JSON.stringify(hist.slice(0, MAX_HISTORY)));
    } catch {
        // ignore
    }
}

export function loadInputDraft(): string {
    try {
        return localStorage.getItem(inputKey()) || '';
    } catch {
        return '';
    }
}

export function saveInputDraft(text: string): void {
    try {
        const k = inputKey();
        if (text) localStorage.setItem(k, text);
        else localStorage.removeItem(k);
    } catch {
        // ignore
    }
}
