// Tab model + persistence for the multi-terminal (Chrome-like) UI.
//
// Each tab is an independent terminal wired to its own WebSocket. Session
// identity is the tmux session name carried in the WS query string
// (`?arg=name:<session>`): the ttyd-session.sh wrapper attaches to that tmux
// session, so a distinct name per tab yields a distinct, independent session
// (same name would mirror the same screen). New tabs therefore mint a fresh
// unique name; the first tab keeps whatever the page was opened with so
// deep-links (cwd:/claude/codex/screen routing) still work.
//
// The whole tab list is persisted to localStorage so a reload reconnects to
// exactly the same sessions — matching the tmux-continuum persistence the
// server already runs (the sessions survive on the host regardless).

export type BarPosition = 'top' | 'bottom' | 'left' | 'right';

// The five mutually-exclusive bar layouts the user picks between: the four
// strip/column positions plus the collapsed floating "menu" overlay.
export type BarMode = BarPosition | 'menu';

export interface TabInfo {
    id: string; // stable unique id (React key + localStorage identity)
    session: string; // tmux session name (display + routing)
    title: string; // label shown on the chip; updated from terminal title events
    search: string; // full WS query string incl. leading '?' (preserves routing)
    renamed?: boolean; // user renamed the tab — terminal title events no longer overwrite it
    group: string; // entry namespace: the session name the page was opened with when
    // this cluster of tabs was spawned. The bar always scopes its list to the
    // active tab's group. An entry tab's group equals its own session.
}

export interface BarState {
    position: BarPosition;
    menuMode: boolean; // collapsed to a single ☰ menu button
    scale?: number; // proportional zoom of the whole bar (1 = default)
    opacity?: number; // opacity of the bar's chrome — chips/buttons (1 = default)
    colWidth?: number; // column width (px) in left/right mode, drag-resizable
    autoHide?: boolean; // hide the bar after a few idle seconds; reveal on edge-hover
}

// Clamp for the drag-resizable column width (left/right mode). Wide enough to
// read a couple of session names, capped so the column can't eat the stage.
export const COL_WIDTH_MIN = 140;
export const COL_WIDTH_MAX = 560;
export const COL_WIDTH_DEFAULT = 190;

export function clampColWidth(w: number): number {
    if (!Number.isFinite(w)) return COL_WIDTH_DEFAULT;
    return Math.max(COL_WIDTH_MIN, Math.min(COL_WIDTH_MAX, Math.round(w)));
}

// Clamp for the bar's chrome opacity. The floor is well above 0 on purpose: the
// bar is already an overlay with no fill of its own, so a fully transparent one
// would leave nothing on screen to grab and no way back to this slider.
export const BAR_OPACITY_MIN = 0.2;
export const BAR_OPACITY_MAX = 1;
export const BAR_OPACITY_DEFAULT = 1;

export function clampOpacity(o: number): number {
    if (!Number.isFinite(o)) return BAR_OPACITY_DEFAULT;
    return Math.max(BAR_OPACITY_MIN, Math.min(BAR_OPACITY_MAX, Math.round(o * 100) / 100));
}

export interface TabsState {
    tabs: TabInfo[];
    activeId: string;
    bar: BarState;
    // Monotonic per-namespace session counter (base name → highest suffix ever
    // handed out). Persisted and synced so "+" never recycles a name whose tmux
    // session is still alive on the host — see allocSession().
    seq?: Record<string, number>;
}

// Exported so the app can tell its own storage writes from those of another
// browser tab pointed at the same deployment (see the `storage` listener).
export const STORE_KEY = 'ttyd.tabs.v1';

function sanitizeName(raw: string): string {
    return (raw || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

export interface Route {
    session: string;
    backend: 'tmux' | 'screen';
    // The query says more than which session to open: a leading cwd:/agent/
    // idle:/noreap modifier, or an explicit tmux/screen session type. A query
    // that only names the session (`name:x`, or a bare positional name) is not
    // routed — it addresses a session without describing how to build it.
    routed: boolean;
}

// Resolve a WS query string to the tmux/screen session it routes to — byte-for-
// byte the way deploy/scripts/ttyd-session.sh parses it. The two MUST agree, or
// the chip label, the per-session vkbd storage and the session actually attached
// drift apart (you type into one session while the UI shows another).
//
// Key subtlety the old `args.find('name:')` got wrong: the wrapper treats
// name:/cwd:/codex[:]/claude[:]/idle:/noreap/restart as *leading* modifiers only. It walks them
// left-to-right until the first non-modifier token (the session spec), and a
// later leading `name:` overwrites an earlier one. A `name:` sitting AFTER the
// session spec is not a modifier there, so it must not win — matching the shell's
// positional handling exactly.
//
// `restart` is skipped like any other leading modifier but deliberately does not
// make a query `routed`: it is a one-shot instruction for a single connect, not
// part of how a session is built (see withoutRestart()).
export function parseRoute(search: string): Route {
    try {
        const args = new URLSearchParams(search).getAll('arg');
        let i = 0;
        let name = '';
        let explicit = false;
        let routed = false;
        while (i < args.length) {
            const a = args[i];
            if (a.startsWith('name:')) {
                name = a.slice('name:'.length); // last leading name: wins, as in the shell
                explicit = true;
                i++;
            } else if (a === 'restart') {
                i++;
            } else if (
                a.startsWith('cwd:') ||
                a === 'codex' ||
                a.startsWith('codex:') ||
                a === 'claude' ||
                a.startsWith('claude:') ||
                a.startsWith('idle:') ||
                a === 'noreap'
            ) {
                routed = true;
                i++;
            } else {
                break;
            }
        }
        const spec = args[i];
        let backend: 'tmux' | 'screen' = 'tmux';
        if (spec === undefined) {
            // No session spec: keep whatever name: gave us (or fall through to main).
        } else if (spec === 'screen') {
            backend = 'screen';
            routed = true;
            if (!explicit) name = args[i + 1] ?? '';
        } else if (spec === 'tmux') {
            routed = true;
            if (!explicit) name = args[i + 1] ?? '';
        } else if (!explicit) {
            name = spec;
        }
        return { session: sanitizeName(name) || 'main', backend, routed };
    } catch {
        return { session: 'main', backend: 'tmux', routed: false };
    }
}

// A query string with every `arg=restart` removed. ttyd-session.sh reads
// `restart` as "kill this session and build it again", so it must only ever
// reach the server on the one connect the user asked for (the xterm adds it
// itself, see Xterm.restartOnNextConnect). Stored in a tab's route it would
// re-run on every reload, wake and reconnect — killing the session each time.
// A query without one is returned untouched, so stored routes keep their exact
// spelling and never churn a sync just from being re-encoded.
export function withoutRestart(search: string): string {
    try {
        const params = new URLSearchParams(search);
        if (!params.getAll('arg').includes('restart')) return search;
        const kept = params.getAll('arg').filter(a => a !== 'restart');
        params.delete('arg');
        for (const a of kept) params.append('arg', a);
        const rest = params.toString();
        return rest ? `?${rest}` : '';
    } catch {
        return search;
    }
}

// Derive the tmux session name a given WS query string routes to. Mirrors the
// precedence in ttyd-session.sh and vkbd/storage.ts ttydSessionName().
export function sessionFromSearch(search: string): string {
    return parseRoute(search).session;
}

// The working directory a WS query string routes to (`cwd:<path>`), or '' when
// it carries none. `cwd:` is an order-independent modifier in ttyd-session.sh,
// so the first one wins — same as the wrapper, where a later `cwd:` would only
// chdir again on top of it.
export function cwdFromSearch(search: string): string {
    try {
        const dir = new URLSearchParams(search).getAll('arg').find(a => a.startsWith('cwd:'));
        return dir ? dir.slice('cwd:'.length) : '';
    } catch {
        return '';
    }
}

// The query string for a tab spawned off `source` (the ＋ button). The new tab
// is its own tmux session, so it gets a fresh `name:`, but it stays in the
// directory the source tab routes to — otherwise "+" from a project deep-link
// would drop you in ttyd's launch cwd instead of the project. Agent modifiers
// (`claude:`/`codex:`) are deliberately *not* inherited: ＋ opens a plain shell,
// and re-running e.g. `claude -c` would fork a second view of the very same
// conversation. Values are encoded by URLSearchParams; ttyd url-decodes each
// `arg=` fragment, so paths with spaces survive the round trip.
export function spawnSearch(source: string | undefined, session: string): string {
    const params = new URLSearchParams();
    const cwd = cwdFromSearch(source || '');
    if (cwd) params.append('arg', `cwd:${cwd}`);
    params.append('arg', `name:${session}`);
    return `?${params.toString()}`;
}

export function backendFromSearch(search: string): 'tmux' | 'screen' {
    return parseRoute(search).backend;
}

let idCounter = 0;
export function genTabId(): string {
    // Tab ids MUST be globally unique, not just unique within one page load: they
    // are shared across devices through the /tabs sync blob and embedded in the
    // URL hash (#tab=<id>), so two browsers minting the same id would make a
    // reload focus the wrong session. crypto.randomUUID is the strong path; it is
    // absent outside a secure context (this UI is routinely served over plain
    // HTTP on a LAN), so fall back to time + randomness + a per-load counter,
    // which is still cross-device-unique unlike the old performance.now counter.
    try {
        const c = (typeof crypto !== 'undefined' ? crypto : undefined) as { randomUUID?: () => string } | undefined;
        if (c?.randomUUID) return `t_${c.randomUUID()}`;
    } catch {
        // ignore — fall through to the manual id
    }
    idCounter += 1;
    const t = Date.now().toString(36);
    const r = Math.floor(Math.random() * 0xffffffff).toString(36);
    return `t_${t}_${r}_${idCounter}`;
}

// Allocate a brand-new tmux session name for a "+" tab in the `base` namespace
// (base-2, base-3, …). The counter is MONOTONIC and persisted in `seq`: closing
// a tab does not kill its tmux session (the host keeps it running for
// tmux-continuum resurrection), so a "lowest free number" scheme would eventually
// hand a new tab a name whose session is still alive — silently reattaching to a
// session the user thought they had closed. Advancing past every number ever
// handed out (and past any currently-open one) guarantees "+" always lands on a
// genuinely new session. `seq` rides in the synced TabsState so two devices
// pointed at the same host never mint the same name either. Returns the updated
// `seq` for the caller to fold back into state.
export function allocSession(state: TabsState, base?: string): { session: string; seq: Record<string, number> } {
    const root = sanitizeName(base || '') || 'main';
    const used = new Set(state.tabs.map(t => t.session));
    const seq: Record<string, number> = { ...(state.seq || {}) };
    let n = Number.isFinite(seq[root]) ? seq[root] : 1;
    // Never regress below a number that's currently open (e.g. a legacy list or a
    // list adopted from another device that carried no seq for this base).
    const re = new RegExp(`^${escapeRegExp(root)}-(\\d+)$`);
    for (const t of state.tabs) {
        const m = re.exec(t.session);
        if (m) n = Math.max(n, Number(m[1]));
    }
    n += 1;
    while (used.has(`${root}-${n}`)) n += 1;
    seq[root] = n;
    return { session: `${root}-${n}`, seq };
}

export function makeTab(session: string, search: string, title?: string, group?: string): TabInfo {
    // An entry tab (opened directly from a URL) owns its own namespace, so group
    // defaults to the session name. Sub-tabs pass the active namespace explicitly.
    return { id: genTabId(), session, search, title: title || session, group: group || session };
}

// The tabs to show for the current view: only the ones belonging to `group`
// (the active tab's entry namespace). The bar is always scoped this way —
// tabs of other sessions are never listed, so a strip can't offer a chip that
// jumps you out of the session you deep-linked into.
export function tabsInView(tabs: TabInfo[], group: string): TabInfo[] {
    return tabs.filter(t => t.group === group);
}

// Active-tab persistence in the URL hash (`#tab=<id>`), so a reload lands on the
// same tab. Kept in the hash, not the query string, so it never interferes with
// the server routing args (`?arg=…`).
export function tabIdFromHash(): string | null {
    try {
        const h = window.location.hash || '';
        const id = new URLSearchParams(h.replace(/^#/, '')).get('tab');
        return id || null;
    } catch {
        return null;
    }
}

// The tab representing however the page was actually opened. Preserves the full
// original query string so all routing modifiers keep working.
export function initialTabFromUrl(): TabInfo {
    const search = withoutRestart(window.location.search || '');
    const session = sessionFromSearch(search);
    return makeTab(session, search, session);
}

function defaultBar(): BarState {
    return {
        position: 'top',
        menuMode: false,
        scale: 1,
        opacity: BAR_OPACITY_DEFAULT,
        colWidth: COL_WIDTH_DEFAULT,
        autoHide: true,
    };
}

// The tab list exactly as this browser stored it, before any reconciling.
export function loadSavedTabs(): TabsState | null {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        return raw ? (JSON.parse(raw) as TabsState) : null;
    } catch {
        return null;
    }
}

export function loadTabsState(): TabsState {
    return normalizeTabsState(loadSavedTabs());
}

// Turn a stored (or received) tab list into one this page can render: fill in
// defaults, repair anything missing, and reconcile it with the URL the page was
// opened at. Shared by the localStorage load and by the server sync, which
// hands over a list written by a different browser and so needs exactly the
// same treatment.
export function normalizeTabsState(saved: TabsState | null): TabsState {
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) {
        const first = initialTabFromUrl();
        return { tabs: [first], activeId: first.id, bar: defaultBar(), seq: {} };
    }

    // Restore, but make sure the session the page was *opened* with is present
    // and focused, so deep-links still land somewhere even with saved tabs.
    const bar: BarState = { ...defaultBar(), ...(saved.bar || {}) };
    bar.colWidth = clampColWidth(bar.colWidth ?? COL_WIDTH_DEFAULT);
    bar.opacity = clampOpacity(bar.opacity ?? BAR_OPACITY_DEFAULT);
    // Tabs saved before namespacing existed have no group. They were one flat
    // list, so fold them all into a single legacy group (the first tab's session)
    // — that keeps them grouped together and visible, never scattered or hidden.
    const legacyGroup = sanitizeName(saved.tabs[0]?.session || '') || 'main';
    const tabs: TabInfo[] = saved.tabs.map(t => ({
        id: t.id || genTabId(),
        session: t.session || sessionFromSearch(t.search || ''),
        search: withoutRestart(t.search || '') || `?arg=name:${t.session}`,
        title: t.title || t.session || 'shell',
        renamed: !!t.renamed,
        group: t.group || legacyGroup,
    }));

    const urlSearch = withoutRestart(window.location.search || '');
    // Only honor an explicit deep-link (has ?arg=...), not a bare reload.
    const hasExplicit = new URLSearchParams(urlSearch).getAll('arg').length > 0;
    let activeId = tabs.find(t => t.id === saved!.activeId)?.id || tabs[0].id;
    if (hasExplicit) {
        const route = parseRoute(urlSearch);
        const urlSession = route.session;
        const existing = tabs.find(t => t.session === urlSession);
        if (existing) {
            // A link that describes the session (cwd:, agent, idle:/noreap,
            // tmux/screen) is the current truth about it — the project moved,
            // the agent flags changed — so it replaces the stored route rather
            // than being thrown away in favour of whatever the tab was first
            // opened with. A link that only names the session (the gateway's
            // "Open" sends just `name:`) says nothing about how to build it, so
            // the stored route stands. id/title/group/renamed are the tab's own
            // and are kept either way. The terminal reconnects on its own when
            // `search` changes (app.tsx keys it on the route), and the caller
            // persists the update — see routesChanged().
            if (route.routed) existing.search = urlSearch;
            activeId = existing.id;
            // A reload keeps the URL it was opened with, so a deep-link would
            // otherwise snap back to the entry tab every time — you would never
            // be able to refresh while sitting on the third tab of a project.
            // The hash wins as long as it points inside the namespace the link
            // addresses; a link to a *different* session still moves you there.
            const hashId = tabIdFromHash();
            const hashTab = hashId ? tabs.find(t => t.id === hashId) : undefined;
            if (hashTab && hashTab.group === existing.group) activeId = hashTab.id;
        } else {
            const t = makeTab(urlSession, urlSearch, urlSession);
            tabs.unshift(t);
            activeId = t.id;
        }
    } else {
        // Bare reload: the URL hash (#tab=<id>) is the strongest signal for which
        // tab to focus, so a refresh returns to exactly where you were.
        const hashId = tabIdFromHash();
        if (hashId && tabs.some(t => t.id === hashId)) activeId = hashId;
    }

    // Carry the monotonic session counter forward so "+" keeps minting fresh
    // names across reloads and across an adopted (cross-device) list.
    const seq: Record<string, number> = saved.seq && typeof saved.seq === 'object' ? { ...saved.seq } : {};

    return { tabs, activeId, bar, seq };
}

// Whether reconciling `saved` into `next` (normalizeTabsState) changed the route
// of any tab it kept — a deep link re-pointing an existing tab, or a stray
// `restart` scrubbed from a stored one. Reconciling is otherwise a pure view of
// the stored list and never needs writing back, but a changed route does: left
// unsaved, the next bare reload (or any other device) would open the old route
// again, and the terminal with it in the old cwd.
export function routesChanged(saved: TabsState | null, next: TabsState): boolean {
    const before = new Map((saved?.tabs || []).map(t => [t.id, t.search]));
    return next.tabs.some(t => before.has(t.id) && before.get(t.id) !== t.search);
}

// `json` lets a caller that already serialised this exact state pass it in
// rather than have it stringified a second time — every commit goes through
// here, including the ones a drag-to-reorder fires per chip it crosses.
export function saveTabsState(state: TabsState, json?: string): void {
    try {
        localStorage.setItem(STORE_KEY, json ?? JSON.stringify(state));
    } catch {
        // storage full / disabled — non-fatal, tabs just won't persist.
    }
}
