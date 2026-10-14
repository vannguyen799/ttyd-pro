import { bind } from 'decko';
import { h, Component } from 'preact';

import { Terminal } from './terminal';
import { VirtualKeyboard } from './vkbd';
import { loadSettings } from './vkbd/storage';
import { TabBar } from './tabs/tabbar';
import {
    BAR_OPACITY_DEFAULT,
    BarMode,
    STORE_KEY,
    TabInfo,
    TabsState,
    allocSession,
    backendFromSearch,
    clampOpacity,
    loadSavedTabs,
    loadTabsState,
    makeTab,
    normalizeTabsState,
    routesChanged,
    saveTabsState,
    spawnSearch,
    tabsInView,
} from './tabs/model';
import { REV_KEY, fetchRemote, flushRemote, loadRev, nextRev, pushRemote, saveRev } from './tabs/sync';

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { ClientOptions, FlowControl } from './terminal/xterm';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const path = window.location.pathname.replace(/[/]+$/, '');
const wsUrlFor = (search: string) => [protocol, '//', window.location.host, path, '/ws', search].join('');
const tokenUrl = [window.location.protocol, '//', window.location.host, path, '/token'].join('');
// The endpoint is still named for images: browser tabs loaded before it
// accepted arbitrary files post to this path, and the server answers both.
const fileUploadUrl = [window.location.protocol, '//', window.location.host, path, '/image-upload'].join('');
const isMobile = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const savedVkbd = loadSettings();
const clientOptions = {
    rendererType: isMobile ? 'dom' : 'webgl',
    // No "Leave site? changes may not be saved" prompt on tab close: the
    // session lives in tmux (start-ttyd.sh) and survives disconnect, so the
    // warning is misleading — closing the tab loses nothing.
    disableLeaveAlert: true,
    disableResizeOverlay: false,
    enableZmodem: false,
    enableTrzsz: false,
    enableSixel: false,
    closeOnDisconnect: false,
    isWindows: false,
    unicodeVersion: '11',
} as ClientOptions;
const termOptions = {
    fontSize: savedVkbd.termFontSize || (isMobile ? 9 : 8),
    fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace',
    theme: {
        foreground: '#d2d2d2',
        background: '#2b2b2b',
        cursor: '#adadad',
        black: '#000000',
        red: '#d81e00',
        green: '#5ea702',
        yellow: '#cfae00',
        blue: '#427ab3',
        magenta: '#89658e',
        cyan: '#00a7aa',
        white: '#dbded8',
        brightBlack: '#686a66',
        brightRed: '#f54235',
        brightGreen: '#99e343',
        brightYellow: '#fdeb61',
        brightBlue: '#84b0d8',
        brightMagenta: '#bc94b7',
        brightCyan: '#37e6e8',
        brightWhite: '#f1f1f0',
    } as ITheme,
    allowProposedApi: true,
} as ITerminalOptions;
const flowControl = {
    limit: 100000,
    highWater: 10,
    lowWater: 4,
} as FlowControl;

declare global {
    interface Window {
        // The active tab's tmux session name / backend, read by the vkbd for
        // per-session input history, drafts and the session-name label. Set by
        // App on every activation so the single vkbd instance follows tabs.
        ttydSession?: string;
        ttydBackend?: 'tmux' | 'screen';
    }
}

// After you switch away from a tab it stays connected ("warm") for this long,
// then goes to sleep — its WebSocket and WebGL context are released. Switching
// back wakes it and reconnects; the tmux session persists on the host the whole
// time, so the screen just redraws with nothing lost.
const SLEEP_MS = 180000;

interface AppState extends TabsState {
    // Tab ids that currently have a live Terminal (the active tab plus any
    // still within their warm window). Ephemeral — never persisted.
    live: string[];
    // Per-tab restart count, folded into the Terminal's key so "Restart
    // session" remounts it (fresh socket, carrying `restart` once). Ephemeral.
    restarts: Record<string, number>;
}

export class App extends Component<Record<string, never>, AppState> {
    // Pending sleep timers, keyed by tab id.
    private sleepTimers = new Map<string, number>();
    // The durable layout as last written out, so publish() can tell a real edit
    // from a re-commit of the same thing.
    private published = '';
    // Revision of the layout this page holds, so a write by another browser tab
    // of the same profile can be told from our own.
    private rev = 0;
    // The page's deep link re-pointed a stored tab's route (see
    // routesChanged). Written out once the server copy has been looked at, so
    // the update lands on whichever list wins instead of racing it.
    private rerouted = false;
    // Tabs whose next Terminal mount should connect with `restart`. Taken (and
    // so cleared) by that mount, which is what keeps a later wake or remount
    // of the same tab from killing its session a second time.
    private restartPending = new Set<string>();

    constructor() {
        super();
        const saved = loadSavedTabs();
        const base = normalizeTabsState(saved);
        this.rerouted = routesChanged(saved, base);
        this.published = JSON.stringify({ tabs: base.tabs, activeId: base.activeId, bar: base.bar, seq: base.seq });
        this.rev = loadRev();
        // Only the active tab starts live; the rest wake lazily when visited.
        this.state = { ...base, live: [base.activeId], restarts: {} };
        // Publish before the first render so the vkbd's initial paint already
        // reads the correct active session.
        this.applyActiveGlobals(base);
        this.syncUrlTab(base.activeId);
    }

    componentDidMount() {
        // The local list is already on screen; if the server holds a newer one
        // (another device moved on since this browser last looked), swap to it.
        void this.syncFromServer();
        window.addEventListener('pagehide', flushRemote);
        window.addEventListener('storage', this.onStorage);
    }

    componentWillUnmount() {
        for (const h of this.sleepTimers.values()) window.clearTimeout(h);
        this.sleepTimers.clear();
        window.removeEventListener('pagehide', flushRemote);
        window.removeEventListener('storage', this.onStorage);
        flushRemote();
    }

    // Reconcile with the deployment-wide tab layout. Whichever side was edited
    // more recently wins outright — see tabs/sync.ts on why this is not a merge.
    //
    // A route the page's deep link changed is a real edit and gets a fresh
    // revision; it is only stamped here, after the comparison, so a stale local
    // list can never outrank a newer one from another device just because this
    // page was opened with a link.
    private async syncFromServer() {
        const remote = await fetchRemote();
        const rerouted = this.rerouted;
        this.rerouted = false;
        if (remote === null) {
            // No endpoint, or nothing stored yet — the local list is all there is.
            if (rerouted) this.publish(this.state, nextRev(), true);
            return;
        }

        const localRev = loadRev();
        if (remote.rev <= localRev) {
            // Our copy is the newer one — make sure the server has it, which
            // also covers the very first run after --tabs-file is switched on.
            if (rerouted) this.publish(this.state, nextRev(), true);
            else if (localRev > remote.rev) this.publish(this.state, localRev, true);
            return;
        }

        // normalize, not adopt-as-is: the incoming list was written by another
        // browser, so it still has to be reconciled with this page's URL (a
        // deep-linked ?arg= session must stay open and focused).
        const adopted = normalizeTabsState(remote.state);
        // One-time migration: a browser that used the app before server sync
        // existed has localRev 0 but may hold tabs whose tmux sessions are still
        // running and which the remote list has never heard of. Fold those onto
        // the adopted list rather than dropping the user's live sessions. This is
        // not a general merge — only when this browser has never synced.
        if (localRev === 0) {
            const known = new Set(adopted.tabs.map(t => t.session));
            const extra = this.state.tabs.filter(t => !known.has(t.session));
            if (extra.length) adopted.tabs = adopted.tabs.concat(extra);
        }
        saveRev(remote.rev);
        this.rev = remote.rev;
        saveTabsState(adopted);
        this.published = JSON.stringify({
            tabs: adopted.tabs,
            activeId: adopted.activeId,
            bar: adopted.bar,
            seq: adopted.seq,
        });
        this.applyActiveGlobals(adopted);
        this.syncUrlTab(adopted.activeId);
        for (const id of this.sleepTimers.keys()) this.cancelSleep(id);
        this.setState({ ...adopted, live: [adopted.activeId] });
        // The adopted list went through this page's deep link too; if that
        // re-pointed one of its tabs, the server copy is now behind.
        if (routesChanged(remote.state, adopted)) this.publish(adopted, nextRev(), true);
    }

    // Hand the durable part of a state to both stores. The revision is what
    // the next reconcile compares against, so it is written alongside.
    //
    // Unchanged payloads are dropped: commit() also runs for things that are
    // not edits at all — a tab going to sleep after three idle minutes — and
    // stamping a fresh revision for those would let a browser sitting untouched
    // in the background outrank a device someone is actually using.
    private publish(s: TabsState, rev: number, force = false) {
        const durable = { tabs: s.tabs, activeId: s.activeId, bar: s.bar, seq: s.seq };
        const json = JSON.stringify(durable);
        if (!force && json === this.published) return;
        this.published = json;
        this.rev = rev;
        saveTabsState(durable, json);
        saveRev(rev);
        pushRemote({ rev, state: durable });
    }

    // Another browser tab of this profile wrote the layout. Without this the two
    // pages hold divergent lists and whichever is closed last silently wins —
    // add a tab in one window, add one in the other, and the first is gone.
    //
    // Only the *list* is adopted: activeId and the live set stay ours, so a
    // title change over in the other window can't yank this one to a different
    // tab or tear down a terminal that is on screen.
    @bind
    private onStorage(e: StorageEvent) {
        if (e.key !== null && e.key !== STORE_KEY && e.key !== REV_KEY) return;
        const rev = loadRev();
        if (rev <= this.rev) return;

        const adopted = loadTabsState();
        const activeId = adopted.tabs.some(t => t.id === this.state.activeId) ? this.state.activeId : adopted.activeId;
        const live = this.wake(
            this.state.live.filter(id => adopted.tabs.some(t => t.id === id)),
            activeId,
        );
        for (const id of this.sleepTimers.keys()) if (!adopted.tabs.some(t => t.id === id)) this.cancelSleep(id);

        const next: AppState = { ...adopted, activeId, live, restarts: this.state.restarts };
        this.rev = rev;
        this.published = JSON.stringify({ tabs: next.tabs, activeId, bar: next.bar, seq: next.seq });
        this.applyActiveGlobals(next);
        this.syncUrlTab(activeId);
        this.setState(next);
    }

    private activeTab(s: TabsState): TabInfo | undefined {
        return s.tabs.find(t => t.id === s.activeId) ?? s.tabs[0];
    }

    // Publish the active session's identity to the globals the vkbd reads
    // (window.ttydSession/ttydBackend). Called synchronously before every
    // setState so children re-render against the new session, not the old one.
    private applyActiveGlobals(s: TabsState) {
        const t = this.activeTab(s);
        if (!t) return;
        window.ttydSession = t.session;
        window.ttydBackend = backendFromSearch(t.search);
    }

    // Wake a tab: cancel any pending sleep and ensure it has a live Terminal.
    private wake(live: string[], id: string): string[] {
        this.cancelSleep(id);
        return live.includes(id) ? live : [...live, id];
    }

    private cancelSleep(id: string) {
        const h = this.sleepTimers.get(id);
        if (h !== undefined) {
            window.clearTimeout(h);
            this.sleepTimers.delete(id);
        }
    }

    // Arm the sleep timer for a tab that just lost focus. Fires unless the tab is
    // re-activated (or already gone) by the time it elapses.
    private scheduleSleep(id: string) {
        this.cancelSleep(id);
        const h = window.setTimeout(() => {
            this.sleepTimers.delete(id);
            if (this.state.activeId === id) return; // became active again
            if (!this.state.live.includes(id)) return; // already asleep/closed
            this.commit({ ...this.state, live: this.state.live.filter(x => x !== id) });
        }, SLEEP_MS);
        this.sleepTimers.set(id, h);
    }

    private commit(next: AppState) {
        this.applyActiveGlobals(next);
        // Persist only the durable tab data, never the ephemeral live set.
        this.publish(next, nextRev());
        this.syncUrlTab(next.activeId);
        this.setState(next);
    }

    // Mirror the active tab id into the URL hash (#tab=<id>) so a reload lands on
    // it. replaceState (not location.hash =) avoids piling up history entries.
    private syncUrlTab(id: string) {
        try {
            const hash = `#tab=${id}`;
            if (window.location.hash !== hash) {
                window.history.replaceState(window.history.state, '', hash);
            }
        } catch {
            // history unavailable — non-fatal, reload just falls back to storage.
        }
    }

    @bind
    private selectTab(id: string) {
        if (id === this.state.activeId) return;
        const prev = this.state.activeId;
        const live = this.wake(this.state.live, id);
        this.scheduleSleep(prev); // keep the tab we're leaving warm for SLEEP_MS
        this.commit({ ...this.state, activeId: id, live });
    }

    @bind
    private addTab() {
        const prev = this.state.activeId;
        // A new tab joins the active tab's namespace so it stays visible under
        // the current "only this session" scope, and is named after that
        // namespace's default session (main-2, main-3, …) rather than a generic
        // tab-N, so the chip says which session it belongs to.
        // It also inherits the active tab's working directory, so ＋ from a
        // project deep-link (`?arg=cwd:/srv/app&…`) opens another terminal in
        // that project rather than in ttyd's launch cwd.
        const active = this.activeTab(this.state);
        const group = active?.group;
        const { session, seq } = allocSession(this.state, group || active?.session);
        const tab = makeTab(session, spawnSearch(active?.search, session), session, group);
        this.scheduleSleep(prev);
        this.commit({
            ...this.state,
            tabs: [...this.state.tabs, tab],
            seq,
            activeId: tab.id,
            live: [...this.state.live, tab.id],
        });
    }

    @bind
    private closeTab(id: string) {
        const { tabs, activeId, live } = this.state;
        const idx = tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const closing = tabs[idx];
        // Never close the last tab of the namespace in view. The strip only
        // lists this group, so removing it would leave nothing here to focus
        // and drop the user into some other session's tab — the exact jump the
        // scoped strip exists to prevent. Other groups are closed as a whole,
        // from the popover.
        if (tabs.filter(t => t.group === closing.group).length <= 1) return;
        const nextTabs = tabs.filter(t => t.id !== id);
        this.cancelSleep(id);
        let nextLive = live.filter(x => x !== id);
        let nextActive = activeId;
        if (activeId === id) {
            // Focus the neighbour, but prefer one in the same namespace so a
            // scoped view doesn't jump to another session; only when the group is
            // now empty do we fall back to any remaining tab. Nearest-left wins,
            // Chrome-like.
            const sameGroup = nextTabs.filter(t => t.group === closing.group);
            // The guard above leaves at least one sibling, so this pool is
            // non-empty; the fallback only covers a list that arrived broken.
            const pool = sameGroup.length ? sameGroup : nextTabs;
            const before = pool.filter(t => tabs.indexOf(t) < idx);
            nextActive = (before.length ? before[before.length - 1] : pool[0]).id;
            nextLive = this.wake(nextLive, nextActive);
        }
        this.commit({ ...this.state, tabs: nextTabs, activeId: nextActive, live: nextLive });
    }

    // Namespaces other than the one on screen, with how many tabs each holds.
    // The strip is scoped to the active group, so without a list here a tab
    // opened under a different session name is unreachable *and* invisible: it
    // keeps riding along in the synced layout with no way to return to it or
    // throw it away.
    private otherGroups(s: AppState, group: string): { group: string; count: number }[] {
        const counts = new Map<string, number>();
        for (const t of s.tabs) if (t.group !== group) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
        return [...counts.entries()].map(([name, count]) => ({ group: name, count }));
    }

    // Move to another namespace by activating one of its tabs — which is what
    // makes the strip switch to it, since the strip follows the active tab.
    @bind
    private switchGroup(group: string) {
        const target = this.state.tabs.find(t => t.group === group);
        if (target) this.selectTab(target.id);
    }

    // Drop a whole namespace from the layout. Same contract as closing a tab:
    // the tmux sessions behind it keep running on the host, this only stops the
    // UI carrying them around. Refuses the active group, which the close guard
    // in closeTab already protects one tab at a time.
    @bind
    private closeGroup(group: string) {
        const active = this.activeTab(this.state);
        if (!group || group === (active?.group ?? '')) return;
        const tabs = this.state.tabs.filter(t => t.group !== group);
        if (tabs.length === this.state.tabs.length || tabs.length === 0) return;
        for (const t of this.state.tabs) if (t.group === group) this.cancelSleep(t.id);
        const live = this.state.live.filter(id => tabs.some(t => t.id === id));
        this.commit({ ...this.state, tabs, live });
    }

    // "Restart session": recreate the tab's tmux session from its route, which is
    // the only way a changed cwd:/agent reaches panes that already run — tmux
    // cannot move a live pane. Bumping the tab's restart count remounts its
    // Terminal; the new one takes the pending flag and sends `restart` on that
    // first connect only. The tab is focused (and woken, if it was asleep) so
    // the user sees the session come back. The confirm lives in the tab bar.
    @bind
    private restartTab(id: string) {
        if (!this.state.tabs.some(t => t.id === id)) return;
        this.restartPending.add(id);
        const prev = this.state.activeId;
        const live = this.wake(this.state.live, id);
        if (prev !== id) this.scheduleSleep(prev);
        const restarts = { ...this.state.restarts, [id]: (this.state.restarts[id] ?? 0) + 1 };
        this.commit({ ...this.state, activeId: id, live, restarts });
    }

    // One-shot: true for the first Terminal mount after restartTab(id).
    private takeRestart(id: string): boolean {
        return this.restartPending.delete(id);
    }

    @bind
    private onTabTitle(id: string, title: string) {
        const clean = (title || '').trim();
        if (!clean) return;
        const tab = this.state.tabs.find(t => t.id === id);
        if (!tab || tab.title === clean) return;
        if (tab.renamed) return; // a manual rename pins the label; don't clobber it
        this.commit({
            ...this.state,
            tabs: this.state.tabs.map(t => (t.id === id ? { ...t, title: clean } : t)),
        });
    }

    // Drag-to-reorder: move `fromId` into `targetId`'s current slot. Called live
    // as the pointer crosses each chip, so the strip reflows during the drag.
    @bind
    private reorderTabs(fromId: string, targetId: string) {
        if (fromId === targetId) return;
        const tabs = [...this.state.tabs];
        const from = tabs.findIndex(t => t.id === fromId);
        const to = tabs.findIndex(t => t.id === targetId);
        if (from < 0 || to < 0) return;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        this.commit({ ...this.state, tabs });
    }

    // Double-click rename. An empty name falls back to the session name; setting
    // `renamed` stops terminal title events from overwriting the chosen label.
    @bind
    private renameTab(id: string, title: string) {
        const clean = (title || '').trim();
        this.commit({
            ...this.state,
            tabs: this.state.tabs.map(t => (t.id === id ? { ...t, title: clean || t.session, renamed: true } : t)),
        });
    }

    @bind
    private setBarMode(mode: BarMode) {
        // The five bar layouts are one exclusive choice: picking a strip/column
        // position turns menu mode off; picking "menu" flips to the overlay and
        // keeps the last position (used again if they switch back).
        const menuMode = mode === 'menu';
        const position = menuMode ? this.state.bar.position : mode;
        this.commit({ ...this.state, bar: { ...this.state.bar, position, menuMode } });
    }

    @bind
    private setBarScale(scale: number) {
        this.commit({ ...this.state, bar: { ...this.state.bar, scale } });
    }

    @bind
    private setBarOpacity(opacity: number) {
        this.commit({ ...this.state, bar: { ...this.state.bar, opacity: clampOpacity(opacity) } });
    }

    @bind
    private setBarColWidth(colWidth: number) {
        this.commit({ ...this.state, bar: { ...this.state.bar, colWidth } });
    }

    @bind
    private setBarAutoHide(autoHide: boolean) {
        this.commit({ ...this.state, bar: { ...this.state.bar, autoHide } });
        // Toggling this moves the bar in/out of the flex flow, so the stage gains
        // or loses the bar's extent exactly once — refit the terminal to it. (While
        // auto-hide is on the stage no longer changes as the bar slides, so there
        // is nothing to refit per hide/reveal.)
        const term = (window as unknown as { term?: { fit?: () => void } }).term;
        if (term?.fit) {
            requestAnimationFrame(() => {
                try {
                    term.fit!();
                } catch {
                    // ignore — the next resize/activation fits it
                }
            });
        }
    }

    render() {
        const { tabs, activeId, bar, live, restarts } = this.state;
        const active = this.activeTab(this.state);
        // The namespace in view is the active tab's group; the strip is always
        // scoped to it, so tabs of other sessions stay out of sight.
        const group = active?.group ?? active?.session ?? '';
        const visibleTabs = tabsInView(tabs, group);
        const otherGroups = this.otherGroups(this.state, group);
        const rootClass = ['app-root', `bar-${bar.position}`, bar.menuMode ? 'bar-menu' : ''].filter(Boolean).join(' ');
        return (
            <div class={rootClass}>
                <TabBar
                    tabs={visibleTabs}
                    otherGroups={otherGroups}
                    activeId={activeId}
                    liveIds={live}
                    position={bar.position}
                    menuMode={bar.menuMode}
                    scale={bar.scale ?? 1}
                    opacity={bar.opacity ?? BAR_OPACITY_DEFAULT}
                    colWidth={bar.colWidth ?? 190}
                    autoHide={bar.autoHide ?? false}
                    onSelect={this.selectTab}
                    onClose={this.closeTab}
                    onAdd={this.addTab}
                    onSetMode={this.setBarMode}
                    onSetScale={this.setBarScale}
                    onSetOpacity={this.setBarOpacity}
                    onSetColWidth={this.setBarColWidth}
                    onSetAutoHide={this.setBarAutoHide}
                    onReorder={this.reorderTabs}
                    onRename={this.renameTab}
                    onSwitchGroup={this.switchGroup}
                    onCloseGroup={this.closeGroup}
                    onRestart={this.restartTab}
                />
                <div class="term-stage">
                    {tabs
                        .filter(t => t.group === group || live.includes(t.id))
                        .map(t => (
                            <div key={t.id} class={`term-pane${t.id === activeId ? ' active' : ''}`}>
                                {/* Sleeping tabs render no Terminal — socket + WebGL
                                released until the tab is activated again. The
                                active tab is always live, so its pane always
                                has a Terminal. Keyed on the route and the
                                restart count: a live Terminal never re-reads
                                wsUrl, so a re-pointed route or a restart has to
                                remount it to reconnect. */}
                                {live.includes(t.id) ? (
                                    <Terminal
                                        key={`${t.id}|${t.search}|${restarts[t.id] ?? 0}`}
                                        id={`terminal-${t.id}`}
                                        active={t.id === activeId}
                                        wsUrl={wsUrlFor(t.search)}
                                        tokenUrl={tokenUrl}
                                        fileUploadUrl={fileUploadUrl}
                                        clientOptions={clientOptions}
                                        termOptions={termOptions}
                                        flowControl={flowControl}
                                        onTitle={title => this.onTabTitle(t.id, title)}
                                        takeRestart={() => this.takeRestart(t.id)}
                                    />
                                ) : null}
                            </div>
                        ))}
                </div>
                <VirtualKeyboard sessionName={active?.session} />
            </div>
        );
    }
}
