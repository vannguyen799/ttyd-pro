import { h, Component, JSX } from 'preact';
import { backendFromSearch, clampColWidth, BAR_OPACITY_MIN, BAR_OPACITY_MAX, BAR_OPACITY_DEFAULT } from './model';
import type { BarMode, BarPosition, TabInfo } from './model';

interface Props {
    tabs: TabInfo[]; // tabs to render (already scoped to the current view)
    otherGroups: { group: string; count: number }[]; // namespaces not in view, listed in the popover
    activeId: string;
    liveIds: string[]; // tabs with a live connection; others are asleep
    position: BarPosition;
    menuMode: boolean;
    scale: number;
    opacity: number; // opacity of the bar's chrome (chips/buttons); 1 = solid
    colWidth: number; // column width (px) in left/right mode
    autoHide: boolean; // collapse the bar when idle; reveal on edge-hover
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: () => void;
    onSetMode: (mode: BarMode) => void;
    onSetScale: (scale: number) => void;
    onSetOpacity: (opacity: number) => void;
    onSetColWidth: (width: number) => void;
    onSetAutoHide: (v: boolean) => void;
    onReorder: (fromId: string, targetId: string) => void;
    onRename: (id: string, title: string) => void;
    onSwitchGroup: (group: string) => void;
    onCloseGroup: (group: string) => void;
    onRestart: (id: string) => void; // recreate the tab's session from its route (already confirmed)
}

interface State {
    menuOpen: boolean; // popover list open (menu mode)
    posOpen: boolean; // position/options popover open
    dragId: string | null; // chip currently being dragged (for styling)
    editingId: string | null; // chip being renamed inline
    editValue: string; // in-progress rename text
    resizing: boolean; // column width drag in progress (left/right mode)
    hidden: boolean; // auto-hide: bar collapsed off its edge
}

// Pointer travel (px) before a press on a chip becomes a drag rather than a tap.
const DRAG_THRESHOLD = 6;

// Press-and-hold on a chip opens the inline rename. Double-click stays the
// desktop gesture, but on touch a double-tap is unreliable (the first tap has
// already switched tabs, and the browser may swallow the second as a zoom), so
// hold is the gesture that actually works on a phone.
const LONG_PRESS_MS = 450;

// Auto-hide timing. Collapse after this long with the pointer off the bar…
const AUTO_HIDE_MS = 2000;
// …and reveal only after the pointer dwells this long inside the edge zone, so a
// pointer merely passing along the edge doesn't pop the bar out.
const AUTO_REVEAL_MS = 500;
// How close (px) to the docked edge the pointer must come to arm the reveal.
const EDGE_ZONE_PX = 24;

// The five exclusive bar layouts, shown as one mode picker.
const MODES: { mode: BarMode; icon: string; label: string }[] = [
    { mode: 'top', icon: '▔', label: 'Top' },
    { mode: 'bottom', icon: '▁', label: 'Bottom' },
    { mode: 'left', icon: '▏', label: 'Left' },
    { mode: 'right', icon: '▕', label: 'Right' },
    { mode: 'menu', icon: '☰', label: 'Menu' },
];

// Chrome-like tab strip. Positionable on any edge (Edge-style vertical tabs on
// left/right), plus a collapsed "menu" mode where a single ☰ button toggles a
// dropdown list of tabs.
export class TabBar extends Component<Props, State> {
    state: State = {
        menuOpen: false,
        posOpen: false,
        dragId: null,
        editingId: null,
        editValue: '',
        resizing: false,
        hidden: false,
    };

    componentDidMount() {
        document.addEventListener('pointerdown', this.onDocDown, true);
        window.addEventListener('pointermove', this.onWinMove, true);
        this.syncAutoHide();
    }
    componentWillUnmount() {
        document.removeEventListener('pointerdown', this.onDocDown, true);
        window.removeEventListener('pointermove', this.onWinMove, true);
        this.clearHideTimer();
        this.clearRevealTimer();
        this.clearPress();
    }

    componentDidUpdate(prev: Props, prevState: State) {
        // Focus + select the rename box the moment it appears.
        if (this.state.editingId && this.state.editingId !== prevState.editingId && this.renameEl) {
            this.renameEl.focus();
            this.renameEl.select();
        }
        // React to auto-hide being toggled or the dock edge changing.
        if (
            prev.autoHide !== this.props.autoHide ||
            prev.position !== this.props.position ||
            prev.menuMode !== this.props.menuMode
        ) {
            this.syncAutoHide();
        }
    }

    private rootEl: HTMLElement | null = null;
    private renameEl: HTMLInputElement | null = null;

    // ── Auto-hide state ──────────────────────────────────────────────
    // Pointer currently over the bar (keeps it out); reveal-zone dwell flag; and
    // the two timers.
    private hovered = false;
    private inZone = false;
    private hideTimer: number | null = null;
    private revealTimer: number | null = null;

    private clearHideTimer() {
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }
    private clearRevealTimer() {
        if (this.revealTimer !== null) {
            window.clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        this.inZone = false;
    }

    // Called on mount and whenever auto-hide / the dock edge changes. Off → show
    // and drop all timers; on → start the idle countdown unless the pointer is
    // already on the bar.
    private syncAutoHide() {
        if (!this.props.autoHide) {
            this.clearHideTimer();
            this.clearRevealTimer();
            if (this.state.hidden) this.setState({ hidden: false });
            return;
        }
        if (!this.hovered) this.armHide();
    }

    // Nothing may hide the bar while it's actively in use (renaming, dragging, or
    // a popover open), else the surface you're working in vanishes under you.
    private hideBlocked() {
        return !!this.state.editingId || !!this.state.dragId || this.state.menuOpen || this.state.posOpen;
    }

    private armHide() {
        this.clearHideTimer();
        if (!this.props.autoHide) return;
        this.hideTimer = window.setTimeout(() => {
            this.hideTimer = null;
            if (this.hovered || this.hideBlocked()) {
                this.armHide(); // still busy — try again after another idle window
                return;
            }
            if (!this.state.hidden) this.setState({ hidden: true });
        }, AUTO_HIDE_MS);
    }

    private reveal = () => {
        this.clearRevealTimer();
        if (this.state.hidden) this.setState({ hidden: false });
        // If the pointer doesn't actually settle on the revealed bar, idle it out.
        this.armHide();
    };

    // Is the pointer within the reveal zone for the current dock edge?
    private inRevealZone(x: number, y: number): boolean {
        if (this.props.menuMode) {
            // Collapsed FAB lives at the top-left corner; reveal from that corner.
            return x <= 72 && y <= 72;
        }
        switch (this.props.position) {
            case 'top':
                return y <= EDGE_ZONE_PX;
            case 'bottom':
                return y >= window.innerHeight - EDGE_ZONE_PX;
            case 'left':
                return x <= EDGE_ZONE_PX;
            case 'right':
                return x >= window.innerWidth - EDGE_ZONE_PX;
        }
    }

    // Global pointer tracking, only meaningful while hidden: arm a dwell timer on
    // entering the edge zone, cancel it on leaving before the dwell completes.
    private onWinMove = (e: PointerEvent) => {
        if (!this.props.autoHide || !this.state.hidden) {
            if (this.revealTimer !== null) this.clearRevealTimer();
            return;
        }
        const zone = this.inRevealZone(e.clientX, e.clientY);
        if (zone && !this.inZone) {
            this.inZone = true;
            if (this.revealTimer === null) this.revealTimer = window.setTimeout(this.reveal, AUTO_REVEAL_MS);
        } else if (!zone && this.inZone) {
            this.clearRevealTimer();
        }
    };

    // Pointer entered/left the bar itself: hold it out while hovered, re-arm the
    // idle countdown once the pointer leaves.
    private onBarEnter = () => {
        this.hovered = true;
        this.clearHideTimer();
        this.clearRevealTimer();
    };
    private onBarLeave = () => {
        this.hovered = false;
        this.armHide();
    };

    // Pointer-drag reorder state. `active` flips once the press passes the
    // threshold; until then the press is still a potential tap (select).
    private drag: { pointerId: number; id: string; startX: number; startY: number; active: boolean } | null = null;
    // After a drag, the trailing click on the same chip must not select it.
    private suppressClickId: string | null = null;

    // Column-width resize (left/right mode). Dragging the inner edge of the
    // vertical column widens/narrows it. `scale` (bar zoom) maps real pointer
    // pixels back to CSS width; `right` mode drags the opposite direction.
    private resize: { pointerId: number; startX: number; startWidth: number } | null = null;

    private onResizeDown = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.resize = { pointerId: e.pointerId, startX: e.clientX, startWidth: this.props.colWidth };
        this.setState({ resizing: true });
        try {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };

    private onResizeMove = (e: PointerEvent) => {
        const r = this.resize;
        if (!r || r.pointerId !== e.pointerId) return;
        const dir = this.props.position === 'right' ? -1 : 1;
        const dx = (dir * (e.clientX - r.startX)) / (this.props.scale || 1);
        this.props.onSetColWidth(clampColWidth(r.startWidth + dx));
    };

    private onResizeUp = (e: PointerEvent) => {
        if (!this.resize || this.resize.pointerId !== e.pointerId) return;
        this.resize = null;
        this.setState({ resizing: false });
        try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };

    // Press-and-hold timer (rename gesture), armed on every chip press.
    private pressTimer: number | null = null;

    private clearPress() {
        if (this.pressTimer !== null) {
            window.clearTimeout(this.pressTimer);
            this.pressTimer = null;
        }
    }

    private armPress(id: string) {
        this.clearPress();
        this.pressTimer = window.setTimeout(() => {
            this.pressTimer = null;
            const t = this.props.tabs.find(x => x.id === id);
            if (!t) return;
            // The press has become a rename: the release must not also select
            // (switch to) the tab, so swallow the click that follows.
            this.suppressClickId = id;
            this.startRename(t);
        }, LONG_PRESS_MS);
    }

    private onChipPointerDown = (id: string, e: PointerEvent) => {
        if (this.state.editingId) return; // no dragging while renaming
        if ((e.target as Element)?.closest?.('.tab-close, .tab-restart')) return; // let the button fire
        this.drag = { pointerId: e.pointerId, id, startX: e.clientX, startY: e.clientY, active: false };
        this.armPress(id);
    };

    private onChipPointerMove = (e: PointerEvent) => {
        const d = this.drag;
        if (!d || d.pointerId !== e.pointerId) return;
        if (!d.active) {
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
            this.clearPress(); // moved: this is a drag/scroll, not a hold
            d.active = true;
            this.setState({ dragId: d.id });
            try {
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }
        // The chip under the pointer becomes the drop target; reorder live.
        const under = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
        const chip = under?.closest?.('.tab-chip') as HTMLElement | null;
        const targetId = chip?.dataset?.tabId;
        if (targetId && targetId !== d.id) this.props.onReorder(d.id, targetId);
    };

    private onChipPointerUp = (e: PointerEvent) => {
        this.clearPress();
        const d = this.drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this.drag = null;
        try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        if (d.active) {
            this.suppressClickId = d.id; // swallow the click that follows the drag
            this.setState({ dragId: null });
        }
    };

    private onChipClick = (id: string, inMenu: boolean) => {
        if (this.suppressClickId === id) {
            this.suppressClickId = null;
            return;
        }
        this.props.onSelect(id);
        if (inMenu) this.setState({ menuOpen: false });
    };

    // Restart is destructive — whatever runs in the session dies — so it asks
    // first. The native confirm is deliberate: it is modal on every platform,
    // including the phone, and cannot be dismissed by the auto-hide timer.
    private confirmRestart = (t: TabInfo, inMenu: boolean) => {
        const ok = window.confirm(
            `Restart session ${t.session}? Kills the running process and recreates the session with this tab's ` +
                "route (cwd/agent). claude -c resumes the latest conversation in the route's cwd.",
        );
        if (!ok) return;
        this.props.onRestart(t.id);
        if (inMenu) this.setState({ menuOpen: false });
    };

    private startRename = (t: TabInfo) => {
        this.clearPress();
        this.drag = null;
        this.setState({ editingId: t.id, editValue: t.title || t.session });
    };

    private commitRename = (id: string) => {
        if (this.state.editingId !== id) return;
        this.props.onRename(id, this.state.editValue);
        this.setState({ editingId: null, editValue: '' });
    };

    private onRenameKey = (id: string, e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.commitRename(id);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.setState({ editingId: null, editValue: '' });
        }
    };

    private onDocDown = (e: PointerEvent) => {
        if (!this.rootEl) return;
        if (!this.rootEl.contains(e.target as Node)) {
            if (this.state.menuOpen || this.state.posOpen) this.setState({ menuOpen: false, posOpen: false });
        }
    };

    private closePopovers = () => this.setState({ menuOpen: false, posOpen: false });

    // The 5-mode picker (Top/Bottom/Left/Right/Menu) as one exclusive choice.
    // Shared between the strip's ⋯ popover and the menu-mode list popover (where
    // it's folded in so the collapsed UI stays a single button). `onDone` closes
    // whichever popover hosts it.
    private renderModeControls(onDone: () => void) {
        const { position, menuMode, onSetMode } = this.props;
        const current: BarMode = menuMode ? 'menu' : position;
        return (
            <div class="tabbar-mode-controls">
                <div class="tabbar-pop-title">Bar layout</div>
                <div class="tabbar-mode-grid">
                    {MODES.map(m => (
                        <button
                            key={m.mode}
                            class={`tabbar-mode-btn${current === m.mode ? ' active' : ''}`}
                            title={m.label}
                            onClick={() => {
                                onSetMode(m.mode);
                                onDone();
                            }}
                        >
                            <span class="tabbar-mode-icon">{m.icon}</span>
                            {m.label}
                        </button>
                    ))}
                </div>
                {this.renderScaleControl()}
                {this.renderOpacityControl()}
                {this.renderAutoHideControl()}
                {this.renderGroupList(onDone)}
            </div>
        );
    }

    // The namespaces that are not on screen. The strip is deliberately scoped to
    // the active one, so this list is the only way back to a tab opened under a
    // different session name — and the only way to throw one away, which
    // otherwise rides along in the synced layout forever. Clicking a row moves
    // there; ✕ drops the whole namespace from the layout (the tmux sessions
    // behind it keep running on the host, exactly as when a tab is closed).
    private renderGroupList(onDone: () => void) {
        const { otherGroups, onSwitchGroup, onCloseGroup } = this.props;
        if (!otherGroups.length) return null;
        return (
            <div class="tabbar-group-list">
                <div class="tabbar-pop-title">Other sessions</div>
                {otherGroups.map(g => (
                    <div key={g.group} class="tabbar-pop-row tabbar-group-row">
                        <button
                            class="tabbar-group-open"
                            title={`Switch to ${g.group}`}
                            onClick={() => {
                                onSwitchGroup(g.group);
                                onDone();
                            }}
                        >
                            <span class="tabbar-group-name">{g.group}</span>
                            <span class="tabbar-group-count">{g.count}</span>
                        </button>
                        <button
                            class="tabbar-group-close"
                            title={`Remove the ${g.group} tabs from this layout`}
                            aria-label={`Remove ${g.group}`}
                            onClick={() => onCloseGroup(g.group)}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>
        );
    }

    // Toggle for the auto-hide behaviour. The bar always floats over the
    // terminal; when this is on it additionally collapses off its edge after a
    // short idle and slides back when the pointer dwells at that edge.
    private renderAutoHideControl() {
        const { autoHide, onSetAutoHide } = this.props;
        return (
            <button
                class={`tabbar-pop-row tabbar-toggle-row${autoHide ? ' active' : ''}`}
                title="Float the bar over the terminal and hide it when idle"
                role="switch"
                aria-checked={autoHide}
                onClick={() => onSetAutoHide(!autoHide)}
            >
                <span class="tabbar-check">{autoHide ? '☑' : '☐'}</span>
                <span class="tabbar-toggle-label">Auto-hide bar</span>
            </button>
        );
    }

    // One labelled percentage slider with a "reset" affordance that appears only
    // once the value has moved off its default. Shared by the two bar sliders
    // below so they stay visually identical in the popover.
    private renderRange(
        label: string,
        value: number,
        def: number,
        min: number,
        max: number,
        step: number,
        title: string,
        onSet: (v: number) => void,
    ) {
        return (
            <div class="tabbar-range-control">
                <div class="tabbar-pop-title" title={title}>
                    {label}
                    <span class="tabbar-range-val">{Math.round(value * 100)}%</span>
                    {value !== def ? (
                        <button class="tabbar-range-reset" onClick={() => onSet(def)}>
                            reset
                        </button>
                    ) : null}
                </div>
                <input
                    type="range"
                    class="tabbar-range-input"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onInput={e => onSet(parseFloat((e.target as HTMLInputElement).value))}
                />
            </div>
        );
    }

    // Proportional zoom of the whole bar. Kept next to the layout picker since
    // both shape the bar's footprint. 60%–160%, snapped to a clean 100% default.
    private renderScaleControl() {
        return this.renderRange(
            'Bar size',
            this.props.scale,
            1,
            0.6,
            1.6,
            0.05,
            'Zoom the whole bar',
            this.props.onSetScale,
        );
    }

    // How strongly the bar's chrome reads over the terminal it floats on. Only
    // the chips and buttons carry it — the popovers stay solid, so the slider
    // you are dragging never fades out from under you.
    private renderOpacityControl() {
        return this.renderRange(
            'Bar opacity',
            this.props.opacity,
            BAR_OPACITY_DEFAULT,
            BAR_OPACITY_MIN,
            BAR_OPACITY_MAX,
            0.05,
            'Fade the tabs and buttons into the terminal behind them',
            this.props.onSetOpacity,
        );
    }

    private renderPosMenu() {
        return (
            <div class="tabbar-pop tabbar-pop-pos" onPointerDown={e => e.stopPropagation()}>
                {this.renderModeControls(() => this.setState({ posOpen: false }))}
            </div>
        );
    }

    private renderChip(t: TabInfo, inMenu: boolean) {
        const { activeId, liveIds, onClose, tabs } = this.props;
        const active = t.id === activeId;
        const asleep = !liveIds.includes(t.id);
        // Governed by the scoped list, not the total across namespaces: the
        // strip only shows this group, so closing its last chip would have to
        // focus a tab from a session that is not on screen. Whole namespaces
        // are disposed of from the popover instead.
        const canClose = tabs.length > 1;
        // ↻ on the active chip only in the strip, where width is scarce and the
        // session you restart is normally the one you are looking at; on every
        // row of the menu list, which has the room. tmux only — the wrapper
        // cannot restart a screen session.
        const canRestart = (active || inMenu) && backendFromSearch(t.search) === 'tmux';
        const dragging = this.state.dragId === t.id;
        const editing = this.state.editingId === t.id;
        return (
            <div
                key={t.id}
                data-tab-id={t.id}
                class={`tab-chip${active ? ' active' : ''}${inMenu ? ' in-menu' : ''}${asleep ? ' sleeping' : ''}${
                    dragging ? ' dragging' : ''
                }`}
                title={
                    editing
                        ? undefined
                        : asleep
                          ? `${t.session} — sleeping (click to reconnect)`
                          : `${t.session} — double-click or press-and-hold to rename`
                }
                onClick={() => this.onChipClick(t.id, inMenu)}
                onDblClick={() => this.startRename(t)}
                onPointerDown={e => this.onChipPointerDown(t.id, e)}
                onPointerMove={this.onChipPointerMove}
                onPointerUp={this.onChipPointerUp}
                onPointerCancel={this.onChipPointerUp}
                // A hold is the rename gesture, so don't let it raise the native
                // long-press menu on touch.
                onContextMenu={e => e.preventDefault()}
            >
                <span class="tab-dot" aria-hidden="true" />
                {editing ? (
                    <input
                        class="tab-rename"
                        ref={el => {
                            this.renameEl = el;
                        }}
                        value={this.state.editValue}
                        autocomplete="off"
                        spellcheck={false}
                        onInput={e => this.setState({ editValue: (e.target as HTMLInputElement).value })}
                        onKeyDown={e => this.onRenameKey(t.id, e)}
                        onBlur={() => this.commitRename(t.id)}
                        onClick={e => e.stopPropagation()}
                        onDblClick={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                    />
                ) : (
                    <span class="tab-title">{t.title || t.session}</span>
                )}
                {canRestart && !editing ? (
                    <button
                        class="tab-restart"
                        aria-label="Restart session"
                        title="Restart session (recreate it with this tab's cwd/agent)"
                        onClick={e => {
                            e.stopPropagation();
                            this.confirmRestart(t, inMenu);
                        }}
                    >
                        ↻
                    </button>
                ) : null}
                {canClose && !editing ? (
                    <button
                        class="tab-close"
                        aria-label="Close tab"
                        title="Close tab"
                        onClick={e => {
                            e.stopPropagation();
                            onClose(t.id);
                        }}
                    >
                        ✕
                    </button>
                ) : null}
            </div>
        );
    }

    private optionsButton() {
        return (
            <button
                class="tabbar-btn tabbar-opts"
                title="Bar position & menu mode"
                aria-label="Bar options"
                onClick={e => {
                    e.stopPropagation();
                    this.setState(s => ({ posOpen: !s.posOpen, menuOpen: false }));
                }}
            >
                ⋯
            </button>
        );
    }

    private addButton() {
        return (
            <button class="tabbar-btn tabbar-add" title="New tab" aria-label="New tab" onClick={this.props.onAdd}>
                ＋
            </button>
        );
    }

    // Drag strip on the column's inner edge (left mode → right edge, right mode
    // → left edge) for resizing the column width. Only rendered in left/right.
    private resizeHandle() {
        return (
            <div
                class={`tabbar-resize${this.state.resizing ? ' resizing' : ''}`}
                title="Drag to resize"
                aria-label="Resize tab column"
                onPointerDown={this.onResizeDown}
                onPointerMove={this.onResizeMove}
                onPointerUp={this.onResizeUp}
                onPointerCancel={this.onResizeUp}
            />
        );
    }

    render() {
        const { tabs, activeId, position, menuMode, scale, opacity, colWidth, autoHide } = this.props;
        const { menuOpen, posOpen, hidden } = this.state;
        const active = tabs.find(t => t.id === activeId);
        const isColumn = position === 'left' || position === 'right';
        // Real layout zoom (not transform) so the bar's own contents reflow at
        // the chosen size instead of being scaled pixels; plus the resizable
        // column width in left/right mode. An empty object leaves both unset.
        const rootStyle: JSX.CSSProperties = {};
        if (scale !== 1) {
            rootStyle.zoom = scale;
            // Published for the CSS: zoom scales the auto-hide overlay's edge
            // insets too, so the stylesheet divides them back out by this.
            rootStyle['--tabbar-zoom' as keyof JSX.CSSProperties] = String(scale);
        }
        // Chrome opacity as an inherited custom property rather than an `opacity`
        // on the root: the popovers are children of the bar, and fading them with
        // it would dim the very controls being used (and the auto-hide fade, which
        // owns the root's own opacity).
        if (opacity !== 1) rootStyle['--tabbar-opacity' as keyof JSX.CSSProperties] = String(opacity);
        if (!menuMode && isColumn) rootStyle.width = `${colWidth}px`;
        // Auto-hide needs no inline geometry: the bar is already pinned to its
        // edge and slides off it with a transform — all in CSS (tabs/style.scss).
        const styleProp = Object.keys(rootStyle).length ? rootStyle : undefined;
        const autoHideCls = autoHide ? ` tabbar-autohide${hidden ? ' hidden' : ''}` : '';

        if (menuMode) {
            // Collapsed: a single floating ☰ button (overlay, like the vkbd
            // icon) toggles the tab list. Click the button again, the ✕ in the
            // list header, or outside — all hide it. Options (bar position,
            // menu-mode toggle) live inside the list so the chrome stays one
            // button. Anchored top-left; the vkbd icon sits bottom-right.
            return (
                <div
                    class={`tabbar tabbar-menu${autoHideCls}`}
                    style={styleProp}
                    ref={el => {
                        this.rootEl = el;
                    }}
                    onPointerDown={e => e.stopPropagation()}
                    onPointerEnter={this.onBarEnter}
                    onPointerLeave={this.onBarLeave}
                >
                    <button
                        class={`tabbar-fab${menuOpen ? ' active' : ''}`}
                        title="Tabs"
                        aria-label="Tabs menu"
                        onClick={e => {
                            e.stopPropagation();
                            this.setState(s => ({ menuOpen: !s.menuOpen, posOpen: false }));
                        }}
                    >
                        <span class="tabbar-fab-icon">☰</span>
                        {tabs.length > 1 ? <span class="tabbar-fab-count">{tabs.length}</span> : null}
                    </button>
                    {menuOpen ? (
                        <div class="tabbar-pop tabbar-pop-list" onPointerDown={e => e.stopPropagation()}>
                            <div class="tabbar-pop-head">
                                <span class="tabbar-pop-title">{active?.title || active?.session || 'Tabs'}</span>
                                <button
                                    class="tabbar-pop-close"
                                    aria-label="Close"
                                    title="Close"
                                    onClick={this.closePopovers}
                                >
                                    ✕
                                </button>
                            </div>
                            {tabs.map(t => this.renderChip(t, true))}
                            <button
                                class="tabbar-pop-row tabbar-pop-add"
                                onClick={() => {
                                    this.props.onAdd();
                                    this.setState({ menuOpen: false });
                                }}
                            >
                                ＋ New tab
                            </button>
                            <div class="tabbar-pop-opts">{this.renderModeControls(this.closePopovers)}</div>
                        </div>
                    ) : null}
                </div>
            );
        }

        return (
            <div
                class={`tabbar tabbar-strip tabbar-${position}${autoHideCls}`}
                style={styleProp}
                ref={el => {
                    this.rootEl = el;
                }}
                onPointerDown={e => e.stopPropagation()}
                onPointerEnter={this.onBarEnter}
                onPointerLeave={this.onBarLeave}
            >
                <div class="tabbar-tabs">{tabs.map(t => this.renderChip(t, false))}</div>
                {this.addButton()}
                <div class="tabbar-spacer" />
                {this.optionsButton()}
                {isColumn ? this.resizeHandle() : null}
                {posOpen ? this.renderPosMenu() : null}
            </div>
        );
    }
}
