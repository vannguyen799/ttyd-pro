import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Base64, ClipboardAddon } from '@xterm/addon-clipboard';
import type { ClipboardSelectionType, IBase64, IClipboardProvider } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { OverlayAddon } from './addons/overlay';
import { ZmodemAddon } from './addons/zmodem';
import { bytesForKeyEvent, bytesForText } from '../../vkbd/actions';
import { loadSettings as loadVkbdSettings } from '../../vkbd/storage';

import '@xterm/xterm/css/xterm.css';

interface TtydTerminal extends Terminal {
    fit(): void;
}

export interface VirtualModHook {
    getMods: () => { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
    consume: () => void;
}

export interface TtydBridge {
    sendBytes: (data: string | Uint8Array) => void;
    scrollLines: (n: number) => void;
    scrollPages: (n: number) => void;
    scrollToBottom: () => void;
    paste: () => Promise<void>;
    pasteFiles: (files: (File | Blob)[]) => Promise<void>;
    // Kept for anything holding a reference to the single-image API.
    pasteImage: (file: Blob) => Promise<void>;
    copySelection: () => Promise<void>;
    setSelectMode: (on: boolean) => void;
    focus: () => void;
    vkbdHook?: VirtualModHook;
}

// Claude's vision pipeline downscales above ~1568px anyway, so shrinking here
// costs no fidelity and keeps a phone-camera paste from shipping 8 MB over a
// mobile link.
const MAX_IMAGE_DIM = 1568;

// Mirrors MAX_UPLOAD_BYTES in src/http.c. Known here only so an oversized file
// fails immediately with a clear message instead of after a 32 MB round trip,
// and so an oversized *image* can be downscaled instead of rejected.
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

// Enough of an extension for the common things that arrive from a clipboard
// with no filename at all. Anything else lands as .bin, which still opens —
// the path is what the agent needs, the extension is a courtesy.
const EXT_BY_TYPE: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'application/zip': 'zip',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/html': 'html',
    'text/markdown': 'md',
};

// ClipboardAddon 0.1.0 ships typings that disagree with its build: the .d.ts
// declares `constructor(provider?)` while the shipped JS is
// `constructor(base64 = Base64, provider = BrowserClipboardProvider)`. Passing
// a provider as the first argument therefore installs it as the *base64 codec*
// and silently keeps the default provider. Construct through this signature so
// the provider lands in the slot the runtime actually reads.
const ClipboardAddonCtor = ClipboardAddon as unknown as new (
    base64: IBase64,
    provider: IClipboardProvider,
) => ClipboardAddon;

// Does this OSC 52 selection field mean "the system clipboard"?
//
// Must accept the EMPTY string, and that is not a nicety: tmux writes
// `ESC ] 52 ; ; <base64> BEL` — captured off the wire — leaving the selection
// field blank, which per the spec means "the default selection" (clipboard).
// The addon does not normalise it; its handler splits on ';' and hands the raw
// first field to the provider, so a `sel === 'c'` test is false for every copy
// tmux sends and the text is dropped without a trace. The stock
// BrowserClipboardProvider has exactly this bug (`"c" !== t ? resolve()`),
// which is why OSC 52 copy never worked here regardless of transport.
const isSystemSel = (sel: ClipboardSelectionType | string): boolean => sel === '' || sel === 'c';

// Normalise any pasted/dropped/picked image to PNG.
//
// Doing this in the browser rather than server-side is what keeps the server
// dependency-free: Claude Code reads the clipboard as `-t image/png` first and
// only falls back to image/bmp, so advertising a JPEG under an image/png
// target would hand it mislabelled bytes. Canvas re-encoding guarantees the
// declared type matches the payload.
async function toPngBlob(src: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(src);
    try {
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d context unavailable');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
        );
    } finally {
        bitmap.close();
    }
}

declare global {
    interface Window {
        term: TtydTerminal;
        ttyd: TtydBridge;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}
type Preferences = ITerminalOptions & ClientOptions;

export type RendererType = 'dom' | 'canvas' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
    closeOnDisconnect: boolean;
}

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    fileUploadUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
}

// `wsUrl` with `arg=restart` as its first arg. First, not last: ttyd-session.sh
// only reads modifiers up to the session spec (`tmux <name>`, a positional
// name), so a trailing one would be silently ignored on routes that have one.
function withRestartArg(wsUrl: string): string {
    const q = wsUrl.indexOf('?');
    if (q < 0) return `${wsUrl}?arg=restart`;
    const rest = wsUrl.slice(q + 1);
    return `${wsUrl.slice(0, q)}?arg=restart${rest ? `&${rest}` : ''}`;
}

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

function addEventListener(target: EventTarget, type: string, listener: EventListener): IDisposable {
    target.addEventListener(type, listener);
    return toDisposable(() => target.removeEventListener(type, listener));
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    // OSC 52 (the escape tmux emits for `load-buffer -w`) is what carries a
    // tmux copy-buffer to the browser. The addon's stock provider writes it
    // with navigator.clipboard.writeText alone, which fails on BOTH of the
    // paths this UI actually runs on:
    //   • plain HTTP (the UI is served on 0.0.0.0:10090, not HTTPS) —
    //     navigator.clipboard is undefined outside a secure context, so the
    //     stock provider throws inside the OSC handler and the copy vanishes;
    //   • no user gesture — the escape arrives on the websocket, long after
    //     the tap that triggered it, and Safari/Firefox reject clipboard
    //     writes that aren't inside a trusted event.
    // Route it through doCopy instead, which degrades HTTPS → execCommand →
    // an explicit "tap to copy" sheet, so the text always reaches the user.
    private clipboardAddon = new ClipboardAddonCtor(new Base64(), {
        readText: sel =>
            isSystemSel(sel) && navigator.clipboard?.readText
                ? navigator.clipboard.readText().catch(() => '')
                : Promise.resolve(''),
        writeText: (sel, text) => (isSystemSel(sel) ? this.doCopy(text) : Promise.resolve()),
    });
    private webLinksAddon = new WebLinksAddon();
    private webglAddon?: WebglAddon;
    private canvasAddon?: CanvasAddon;
    private zmodemAddon?: ZmodemAddon;

    private socket?: WebSocket;
    private token: string;
    private opened = false;
    // The bridge (window.ttyd) and window.term binding for this terminal. Built
    // once in open() and installed onto the window globals only while this tab
    // is the active one — see activate(). Keeping the assignment out of open()
    // is what lets many terminals coexist without fighting over the singletons
    // the virtual keyboard talks to.
    private bridge?: TtydBridge;
    private title?: string;
    private processTitle = '';
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    private closeOnDisconnect = false;
    private reconnecting = false;
    private trzszEnabled = false;
    private autoReconnectSetup = false;
    private resumeDisposables: IDisposable[] = [];
    private pendingReconnectKey?: IDisposable;
    // Send `restart` on the next connect() only — see restartOnNextConnect().
    private restartNext = false;

    private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));
    private fitRaf = 0;

    private selTip: HTMLDivElement | null = null;
    private selTipDismiss: (() => void) | null = null;
    private copySheet: HTMLDivElement | null = null;
    private selTipDebounce = 0;
    private lastSel = '';

    // Touch "select mode" (mobile): xterm builds selections from mouse drags,
    // which never happen on a touchscreen. When on, each terminal tap is
    // turned into a synthetic mouse gesture — first tap = drag start (cell
    // anchor), second tap = drag end — so xterm's own selection logic runs
    // and the copy tooltip appears. Stays on until toggled off.
    private selectMode = false;
    private selStage: 0 | 1 = 0;
    private selAnchorPt: { x: number; y: number } | null = null;
    private selBanner: HTMLDivElement | null = null;
    private onSelectPointer: ((e: PointerEvent) => void) | null = null;

    constructor(
        private options: XtermOptions,
        private sendCb: () => void,
        // Bubbles the terminal's window/process title up to the tab bar so the
        // owning tab chip can relabel itself.
        private onTitle?: (title: string) => void,
    ) {}

    // Coalesce fit() calls to one per frame, skip invalid/no-op dims, and
    // resize only when the WriteBuffer has drained. terminal.write() is
    // async — data is queued and processed across multiple ticks. If
    // fitAddon.fit() resizes between ticks of one batch, the next tick
    // parses against new geometry with stale buffer.y, so
    // buffer.lines.get(ybase + y) returns undefined and crashes inside
    // print() with "Cannot read properties of undefined (reading
    // 'setCellFromCodepoint')" or inside lineFeed() with "...setting
    // 'isWrapped'". terminal.write('', cb) fires cb after all currently
    // queued data is processed, giving us a safe resize window.
    @bind
    private safeFit() {
        if (this.fitRaf) return;
        this.fitRaf = requestAnimationFrame(() => {
            this.fitRaf = 0;
            const t = this.terminal;
            if (!t || !t.element || !t.element.parentElement) return;
            t.write('', () => {
                if (!this.terminal || !this.terminal.element || !this.terminal.element.parentElement) return;
                const dims = this.fitAddon.proposeDimensions();
                if (!dims) return;
                if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
                if (dims.cols < 2 || dims.rows < 1) return;
                if (this.terminal.cols === dims.cols && this.terminal.rows === dims.rows) return;
                try {
                    this.fitAddon.fit();
                } catch (e) {
                    console.warn('[ttyd] fit failed', e);
                }
            });
        });
    }

    dispose() {
        if (this.fitRaf) {
            cancelAnimationFrame(this.fitRaf);
            this.fitRaf = 0;
        }
        this.hideSelTip();
        this.hideCopySheet();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    // Full teardown for when a tab is put to sleep (unmounted after its warm
    // window elapses): close the socket and dispose the xterm instance so the
    // WebSocket, its WebGL context and DOM are all released. dispose() alone —
    // used on reconnect — deliberately keeps the socket and terminal alive, so
    // sleeping needs this stronger path. The tmux session lives on the host, so
    // waking the tab later just reconnects and redraws the current screen.
    @bind
    public destroy() {
        this.reconnect = false;
        this.doReconnect = false;
        this.autoReconnectSetup = false;
        for (const d of this.resumeDisposables) d.dispose();
        this.resumeDisposables.length = 0;
        this.dispose();
        try {
            this.socket?.close();
        } catch {
            // ignore
        }
        this.socket = undefined;
        try {
            this.terminal?.dispose();
        } catch {
            // ignore
        }
    }

    // Copy text to the system clipboard, degrading through every mechanism the
    // browser might still allow. Never rejects: the last tier hands the text to
    // the user instead of failing silently.
    //
    //   1. navigator.clipboard — needs a secure context (HTTPS or localhost)
    //      AND, on Safari/Firefox, a live user gesture.
    //   2. execCommand('copy') — the only tier that works over plain HTTP, but
    //      still wants user activation.
    //   3. the copy sheet — shows the text preselected behind one button, so
    //      the tap that dismisses it *is* the gesture tier 2 was missing.
    //
    // Tier 3 is the normal path for clipboard writes that originate server-side
    // (OSC 52 from tmux) on a plain-HTTP origin, because no gesture is live
    // when the escape lands. Serving the UI over HTTPS promotes those to tier 1
    // and makes the copy seamless.
    private async doCopy(text: string): Promise<void> {
        if (!text) return;
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch {
                // Not a secure context, or no user activation — keep degrading.
            }
        }
        if (this.execCommandCopy(text)) return;
        this.showCopySheet(text);
    }

    private execCommandCopy(text: string): boolean {
        const active = document.activeElement as HTMLElement | null;
        const ta = document.createElement('textarea');
        ta.value = text;
        // readOnly keeps iOS from raising the on-screen keyboard for the
        // split second the textarea holds focus.
        ta.readOnly = true;
        ta.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;';
        document.body.appendChild(ta);
        let ok = false;
        try {
            ta.focus({ preventScroll: true });
            // select() alone is a no-op on iOS Safari for readOnly fields.
            ta.setSelectionRange(0, ta.value.length);
            ok = document.execCommand('copy');
        } catch {
            ok = false;
        }
        ta.remove();
        // Hand focus back, or the terminal stops receiving keystrokes after a copy.
        const helper = this.terminal?.element?.querySelector('.xterm-helper-textarea') as HTMLElement | null;
        (active ?? helper)?.focus?.({ preventScroll: true });
        return ok;
    }

    // Last-resort copy UI: the text sits preselected in a textarea behind a
    // Copy button. Pressing it retries the copy inside a genuine user gesture,
    // which is exactly what the earlier tiers lacked; long-press → Copy still
    // works as a manual escape hatch if even that is blocked.
    private showCopySheet(text: string) {
        this.hideCopySheet();

        const wrap = document.createElement('div');
        wrap.className = 'ttyd-copy-sheet';

        const box = document.createElement('div');
        box.className = 'ttyd-copy-sheet-box';

        const label = document.createElement('div');
        label.className = 'ttyd-copy-sheet-label';
        label.textContent = 'Tap Copy to put this on your clipboard';

        const ta = document.createElement('textarea');
        ta.className = 'ttyd-copy-sheet-text';
        ta.value = text;
        ta.readOnly = true;
        ta.spellcheck = false;

        const row = document.createElement('div');
        row.className = 'ttyd-copy-sheet-row';

        const copy = document.createElement('button');
        copy.className = 'ttyd-copy-sheet-btn primary';
        copy.textContent = '⎘ Copy';
        copy.addEventListener('click', () => {
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(0, ta.value.length);
            let ok = false;
            try {
                ok = document.execCommand('copy');
            } catch {
                ok = false;
            }
            if (!ok && navigator.clipboard?.writeText) {
                void navigator.clipboard
                    .writeText(text)
                    .then(() => {
                        this.hideCopySheet();
                        this.overlayAddon?.showOverlay('✂', 300);
                    })
                    .catch(() => {
                        // Leave the sheet open so the text can still be
                        // selected by hand rather than lost.
                        label.textContent = 'Blocked by the browser — select the text and copy manually';
                    });
                return;
            }
            if (ok) {
                this.hideCopySheet();
                this.overlayAddon?.showOverlay('✂', 300);
            } else {
                label.textContent = 'Blocked by the browser — select the text and copy manually';
            }
        });

        const close = document.createElement('button');
        close.className = 'ttyd-copy-sheet-btn';
        close.textContent = 'Close';
        close.addEventListener('click', () => this.hideCopySheet());

        row.append(copy, close);
        box.append(label, ta, row);
        wrap.appendChild(box);
        // Backdrop click dismisses; clicks inside the box must not.
        box.addEventListener('pointerdown', e => e.stopPropagation());
        wrap.addEventListener('pointerdown', () => this.hideCopySheet());

        document.body.appendChild(wrap);
        this.copySheet = wrap;
        ta.setSelectionRange(0, ta.value.length);
    }

    private hideCopySheet() {
        this.copySheet?.remove();
        this.copySheet = null;
        this.terminal?.focus();
    }

    private showSelTip(sel: string) {
        // Debounce: only commit the tooltip 180ms after the last selection
        // change so it doesn't flicker during mouse-drag.
        window.clearTimeout(this.selTipDebounce);
        this.selTipDebounce = window.setTimeout(() => {
            this._renderSelTip(sel);
        }, 180);
    }

    private _renderSelTip(sel: string) {
        // Remove any previous tip before creating a new one.
        this.selTipDismiss?.();
        this.selTipDismiss = null;
        this.selTip?.remove();
        this.selTip = null;

        const tip = document.createElement('div');
        tip.className = 'ttyd-sel-tip';

        const txt = document.createElement('span');
        txt.className = 'ttyd-sel-tip-text';
        const firstLine = sel.split('\n')[0].trimEnd();
        txt.textContent = firstLine.length > 72 ? firstLine.slice(0, 72) + '…' : firstLine || sel.slice(0, 72);

        const btn = document.createElement('button');
        btn.className = 'ttyd-sel-tip-copy';
        btn.textContent = '⎘ Copy';
        btn.addEventListener('click', e => {
            e.stopPropagation();
            void this.doCopy(sel).then(() => this.overlayAddon?.showOverlay('✂', 300));
            this.hideSelTip();
        });

        tip.appendChild(txt);
        tip.appendChild(btn);
        tip.addEventListener('pointerdown', e => e.stopPropagation());

        const el = this.terminal?.element;
        const pos = this.terminal?.getSelectionPosition?.();
        if (pos && el) {
            const rect = el.getBoundingClientRect();
            const cellH = rect.height / Math.max(1, this.terminal.rows);
            const cellW = rect.width / Math.max(1, this.terminal.cols);
            const tx = Math.max(4, Math.min(rect.left + pos.end.x * cellW, window.innerWidth - 248));
            const ty = Math.max(4, Math.min(rect.top + (pos.end.y + 1) * cellH + 6, window.innerHeight - 44));
            tip.style.left = tx + 'px';
            tip.style.top = ty + 'px';
        } else if (el) {
            const rect = el.getBoundingClientRect();
            tip.style.left = rect.left + 8 + 'px';
            tip.style.top = Math.min(rect.bottom - 48, window.innerHeight - 44) + 'px';
        }

        document.body.appendChild(tip);
        this.selTip = tip;

        const dismiss = () => this.hideSelTip();
        // Small delay so the pointerup that ended the drag doesn't immediately dismiss.
        const t = window.setTimeout(() => {
            document.addEventListener('pointerdown', dismiss, { once: true });
            this.selTipDismiss = () => {
                window.clearTimeout(t);
                document.removeEventListener('pointerdown', dismiss);
            };
        }, 250);
        this.selTipDismiss = () => {
            window.clearTimeout(t);
            document.removeEventListener('pointerdown', dismiss);
        };
    }

    private hideSelTip() {
        window.clearTimeout(this.selTipDebounce);
        this.selTipDebounce = 0;
        this.selTipDismiss?.();
        this.selTipDismiss = null;
        this.selTip?.remove();
        this.selTip = null;
    }

    // ── Touch select mode ────────────────────────────────────────────────
    private setSelectMode(on: boolean) {
        if (on === this.selectMode) return;
        this.selectMode = on;
        if (on) this.enterSelectMode();
        else this.exitSelectMode();
    }

    private enterSelectMode() {
        const el = this.terminal?.element;
        if (!el) {
            this.selectMode = false;
            return;
        }
        this.selStage = 0;
        this.selAnchorPt = null;
        this.terminal?.clearSelection();
        this.hideSelTip();
        // Capture-phase so the tap never reaches xterm's own pointerdown
        // (which would focus the helper textarea and pop the OS keyboard).
        this.onSelectPointer = (e: PointerEvent) => this.handleSelectTap(e);
        el.addEventListener('pointerdown', this.onSelectPointer, true);
        this.showSelBanner('✂ Tap selection start');
    }

    private exitSelectMode() {
        const el = this.terminal?.element;
        if (el && this.onSelectPointer) el.removeEventListener('pointerdown', this.onSelectPointer, true);
        this.onSelectPointer = null;
        // Release any half-finished drag so xterm's document listeners detach.
        if (this.selStage === 1 && this.selAnchorPt) {
            this.synthMouse('mouseup', this.selAnchorPt.x, this.selAnchorPt.y, document);
        }
        this.selStage = 0;
        this.selAnchorPt = null;
        this.hideSelBanner();
    }

    private handleSelectTap(e: PointerEvent) {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        const el = this.terminal?.element;
        if (!el) return;
        const x = e.clientX;
        const y = e.clientY;
        if (this.selStage === 0) {
            // First tap: start a drag at the tapped cell (no mouseup yet, so
            // xterm stays in "dragging" state until the second tap).
            this.terminal?.clearSelection();
            this.synthMouse('mousedown', x, y, el);
            this.selAnchorPt = { x, y };
            this.selStage = 1;
            this.showSelBanner('✂ Tap selection end');
        } else {
            // Second tap: extend to here and release — onSelectionChange then
            // fires and the copy tooltip appears.
            this.synthMouse('mousemove', x, y, document);
            this.synthMouse('mouseup', x, y, document);
            this.selStage = 0;
            this.selAnchorPt = null;
            this.showSelBanner('✂ Tap selection start');
        }
        // xterm's own capture pointerdown handler runs before ours and flips
        // the helper textarea to inputmode=text; undo that so the tap doesn't
        // pop the OS keyboard while the user is selecting.
        const ta = el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (ta) {
            ta.inputMode = 'none';
            ta.blur();
        }
    }

    private synthMouse(type: 'mousedown' | 'mousemove' | 'mouseup', x: number, y: number, target: EventTarget) {
        target.dispatchEvent(
            new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                button: 0,
                buttons: type === 'mouseup' ? 0 : 1,
                // xterm's selection mousedown only starts on detail===1.
                detail: type === 'mousedown' ? 1 : 0,
            }),
        );
    }

    private showSelBanner(text: string) {
        if (!this.selBanner) {
            const b = document.createElement('div');
            b.className = 'ttyd-sel-mode-banner';
            document.body.appendChild(b);
            this.selBanner = b;
        }
        this.selBanner.textContent = text;
    }

    private hideSelBanner() {
        this.selBanner?.remove();
        this.selBanner = null;
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        this.zmodemAddon?.sendFile(files);
    }

    private pasteTarget(): 'claude' | 'path' {
        // Prefer the live process title. A saved tab can say `claude` while
        // its existing tmux session is now running Codex (or vice versa), so
        // the URL is only a startup fallback before the first OSC title.
        if (this.processTitle) {
            return /(?:^| - )CLAUDE$/i.test(this.processTitle) ? 'claude' : 'path';
        }
        try {
            let agent = '';
            for (const arg of new URL(this.options.wsUrl).searchParams.getAll('arg')) {
                if (arg === 'claude' || arg.startsWith('claude:')) agent = 'claude';
                if (arg === 'codex' || arg.startsWith('codex:')) agent = 'codex';
            }
            if (agent) return agent === 'claude' ? 'claude' : 'path';
        } catch {
            // A plain path is understood by Codex and remains useful text in
            // any other foreground program.
        }
        return 'path';
    }

    // Name an upload that arrived without one — a screenshot straight off the
    // clipboard, mainly, where the browser hands over bare bytes.
    private nameForBlob(blob: Blob, index: number): string {
        const subtype = blob.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? '';
        const ext = EXT_BY_TYPE[blob.type] ?? (subtype && subtype.length <= 5 ? subtype : 'bin');
        const stem = blob.type.startsWith('image/') ? 'pasted-image' : 'pasted-file';
        return index === 0 ? `${stem}.${ext}` : `${stem}-${index + 1}.${ext}`;
    }

    // Decide what bytes to send and under what name.
    //
    // A real file travels untouched: an agent told to read `report.pdf` has to
    // get the same bytes the user has locally, and re-encoding a dropped photo
    // would hand it a different file than the one it was shown. Only a
    // nameless clipboard bitmap is normalised to PNG — that is the screenshot
    // case the bridge started life handling, and there is no original file to
    // be faithful to.
    private async prepareUpload(item: File | Blob, index: number): Promise<{ blob: Blob; name: string }> {
        const named = item instanceof File && item.name ? item.name : '';
        const isImage = item.type.startsWith('image/');
        const tooBig = (size: number) => `too large (${Math.round(size / 1048576)} MB, limit 32 MB)`;

        if (!named) {
            const blob = isImage ? await toPngBlob(item) : item;
            if (blob.size > MAX_UPLOAD_BYTES) throw new Error(tooBig(blob.size));
            return { blob, name: this.nameForBlob(blob, index) };
        }

        if (item.size > MAX_UPLOAD_BYTES) {
            // A phone photo is routinely over the cap and is exactly what the
            // downscale path exists for; anything else the user has to shrink
            // themselves, so say so instead of failing at the server.
            if (!isImage) throw new Error(`${named} ${tooBig(item.size)}`);
            const blob = await toPngBlob(item);
            if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`${named} ${tooBig(blob.size)}`);
            return { blob, name: `${named.replace(/\.[^.]*$/, '') || 'image'}.png` };
        }

        return { blob: item, name: named };
    }

    private async uploadOne(blob: Blob, name: string): Promise<string> {
        const resp = await fetch(this.options.fileUploadUrl, {
            method: 'POST',
            headers: {
                'Content-Type': blob.type || 'application/octet-stream',
                // A header may only carry ASCII; the server percent-decodes and
                // sanitises this before anything reaches the filesystem.
                'X-Ttyd-Filename': encodeURIComponent(name),
                // Same credential the WS handshake uses — ttyd's /token
                // returns base64("user:pass"); see refreshToken() above.
                ...(this.token ? { Authorization: `Basic ${this.token}` } : {}),
            },
            body: blob,
        });
        const detail = (await resp.json().catch(() => ({}))) as { error?: string; path?: string };
        if (!resp.ok) throw new Error(detail.error || `HTTP ${resp.status}`);
        if (!detail.path) throw new Error('upload returned no path');
        return detail.path;
    }

    // Paste files into whichever supported agent is in the foreground. The
    // server stores each one as a private temporary file under the user's
    // account. Codex recognizes an explicitly pasted path as an attachment;
    // Claude's documented @file syntax adds the same file to its context. Both
    // travel as ordinary terminal input, so this path never needs a host
    // clipboard or X11.
    @bind
    public async pasteFiles(items: (File | Blob)[]) {
        const { overlayAddon } = this;
        if (items.length === 0) return;

        const short = (name: string) => (name.length > 24 ? `${name.slice(0, 21)}…` : name);
        const paths: string[] = [];
        try {
            for (let i = 0; i < items.length; i++) {
                const { blob, name } = await this.prepareUpload(items[i], i);
                const label = items.length > 1 ? `📎 ${i + 1}/${items.length} ${short(name)}` : `📎 ${short(name)}`;
                // Uploads run one at a time: the progress count stays honest,
                // and a multi-file drop can't put several tens of megabytes
                // in flight at once against a single-threaded server.
                overlayAddon?.showOverlay(label, 30000);
                paths.push(await this.uploadOne(blob, name));
            }
        } catch (e) {
            console.warn('[ttyd] upload failed', e);
            overlayAddon?.showOverlay(`📎 ${(e as Error).message}`, 3000);
        }
        // Whatever made it through is still worth pasting — a failure on file
        // three shouldn't discard the first two.
        if (paths.length === 0) return;

        const prefix = this.pasteTarget() === 'claude' ? '@' : '';
        const reference = paths.map(p => prefix + p).join(' ');
        // Trailing space so the agent treats the last path as finished and the
        // user can keep typing straight away.
        this.sendData(`\x1b[200~${reference} \x1b[201~`);
        if (paths.length === items.length)
            overlayAddon?.showOverlay(`📎 ${paths.length} file${paths.length > 1 ? 's' : ''}`, 600);
    }

    @bind
    public async pasteImage(src: Blob) {
        await this.pasteFiles([src]);
    }

    @bind
    public async refreshToken() {
        // Persist the credential client-side so an expiring browser Basic-Auth
        // cache (Chrome/Safari drop it after a few hours) doesn't pop a fresh
        // login dialog on the next reconnect. ttyd's /token returns
        // base64("user:pass") — the exact string its check_auth() wants in the
        // Authorization header — so a saved token can be replayed verbatim.
        const CRED_KEY = 'ttyd.cred.v1';
        const stored = localStorage.getItem(CRED_KEY) || '';
        const fetchToken = (cred: string) =>
            fetch(this.options.tokenUrl, cred ? { headers: { Authorization: `Basic ${cred}` } } : undefined);
        try {
            let resp = await fetchToken(stored);
            // Saved credential rejected (e.g. password rotated server-side):
            // forget it and retry unauthenticated so the browser prompts once
            // to re-capture, restoring the original gating behaviour.
            if (resp.status === 401 && stored) {
                localStorage.removeItem(CRED_KEY);
                resp = await fetchToken('');
            }
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
                // Empty token = server started with --no-auth; nothing to save.
                if (this.token) localStorage.setItem(CRED_KEY, this.token);
                else localStorage.removeItem(CRED_KEY);
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
        }
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        event.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        return undefined;
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, clipboardAddon, webLinksAddon } = this;

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(clipboardAddon);
        terminal.loadAddon(webLinksAddon);

        terminal.open(parent);
        this.safeFit();

        // Intercept beforeinput on the xterm helper textarea so virtual
        // modifiers (tapped on the vkbd) apply to Android/IME keystrokes
        // typed directly on the terminal. Without this, composition events
        // from on-screen keyboards would bypass attachCustomKeyEventHandler
        // (which only sees keydown).
        try {
            const ta = terminal.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
            const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
            // Android-only: the Gboard char-drop workaround below must not run
            // on iOS. WebKit ignores preventDefault() on `beforeinput` at
            // word-commit boundaries (i.e. the spacebar), so intercepting +
            // re-sending there delivers the char once to the PTY AND lets the
            // textarea mutate — xterm then sends it again, doubling every space.
            const isAndroid = /Android/i.test(navigator.userAgent || '');
            if (ta) {
                ta.addEventListener('beforeinput', (event: InputEvent) => {
                    if (event.inputType !== 'insertText' && event.inputType !== 'insertCompositionText') return;
                    const data = event.data;
                    const hook = window.ttyd?.vkbdHook;
                    const vm = hook?.getMods();
                    const hasMods = !!vm && (vm.ctrl || vm.shift || vm.alt || vm.meta);

                    // (1) Virtual modifiers tapped on the vkbd, applied to
                    // Android/IME keystrokes typed directly on the terminal.
                    if (hook && vm && hasMods) {
                        if (!data) return;
                        event.preventDefault();
                        let bytes = '';
                        for (const ch of data) bytes += bytesForText(ch, vm);
                        this.sendData(bytes);
                        hook.consume();
                        return;
                    }

                    // (2) Android reliability: xterm.js reads typed input from
                    // this hidden textarea via its CompositionHelper, and on
                    // Android (Gboard composes every word even with suggestions
                    // off) fast typing drops characters at composition
                    // boundaries. For COMMITTED, non-composition text deliver it
                    // straight to the PTY and preventDefault so the textarea
                    // never changes — xterm therefore can't double-send.
                    // Composition input (event.isComposing / Vietnamese Telex,
                    // CJK) is left untouched so diacritic/IME composition keeps
                    // working through xterm's normal path. Gated to Android only
                    // because iOS ignores preventDefault here and double-sends.
                    if (isAndroid && event.inputType === 'insertText' && !event.isComposing && data) {
                        event.preventDefault();
                        this.sendData(data);
                    }
                });

                // On coarse-pointer devices (mobile) the OS keyboard pops up
                // whenever this hidden textarea is focused — and xterm focuses
                // it from many non-typing paths: synthesized wheel events from
                // the vkbd scroll keys, reconnect-time focus, the vkbd's own
                // post-action focus, etc. That makes the Android keyboard
                // appear on plain vkbd button taps the user never meant as
                // "start typing". Default the textarea to inputmode="none" (it
                // stays focusable, so xterm keeps receiving key events, but the
                // OS keyboard never shows) and only promote it to
                // inputmode="text" when the user genuinely taps the terminal
                // itself. Reset on blur so the next programmatic focus stays
                // silent. The blur() defenses in the vkbd remain as backup.
                if (coarse) {
                    ta.inputMode = 'none';
                    terminal.element?.addEventListener(
                        'pointerdown',
                        (event: Event) => {
                            if (event.isTrusted) ta.inputMode = 'text';
                        },
                        true,
                    );
                    ta.addEventListener('blur', () => {
                        ta.inputMode = 'none';
                    });
                }
            }
        } catch {
            // ignore
        }

        terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (event.type !== 'keydown') return true;

            // Let the browser generate its paste event, but do not also send a
            // raw Ctrl+V to the PTY before the async image upload has finished.
            // Text paste is still handled by xterm's paste listener; image
            // paste is handled by onPaste below.
            const isPasteShortcut =
                !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey);
            if (isPasteShortcut) return false;

            // Mac Cmd+C or cross-platform Ctrl+Shift+C: copy selection.
            // Called directly in a keydown handler so navigator.clipboard is
            // available under the browser's user-gesture requirement (Safari
            // and Chrome both block clipboard writes outside trusted events).
            const isMacCopy = event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'c';
            const isCtrlShiftCopy =
                event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key === 'C';
            if (isMacCopy || isCtrlShiftCopy) {
                const sel = terminal.getSelection();
                if (sel) {
                    void this.doCopy(sel)
                        .then(() => this.overlayAddon?.showOverlay('✂', 300))
                        .catch(e => console.warn('[ttyd] copy failed', e));
                    return false;
                }
                // No selection on Mac: suppress Cmd+C so it doesn't emit meta+c escape.
                if (isMacCopy) return false;
                return true;
            }

            const hook = window.ttyd?.vkbdHook;
            if (!hook) return true;
            const vm = hook.getMods();
            if (!vm.ctrl && !vm.shift && !vm.alt && !vm.meta) return true;
            const combined = {
                ctrl: vm.ctrl || event.ctrlKey,
                shift: vm.shift || event.shiftKey,
                alt: vm.alt || event.altKey,
                meta: vm.meta || event.metaKey,
            };
            const bytes = bytesForKeyEvent(event, combined);
            if (bytes === null) return true;
            event.preventDefault();
            this.sendData(bytes);
            hook.consume();
            return false;
        });

        const getViewport = (): HTMLElement | null =>
            (terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null) ?? null;
        const getRowHeight = (): number => {
            const vp = getViewport();
            if (!vp || terminal.rows <= 0) return 20;
            return vp.clientHeight / terminal.rows;
        };
        // Where a synthesized wheel should "happen". Under tmux with mouse
        // reporting on, xterm turns the wheel into an escape sequence carrying
        // the cell coordinates, and tmux scrolls whichever pane sits under
        // them — so aiming at the geometric centre scrolls whatever pane owns
        // the middle of the window, not the one the user is working in.
        // The terminal cursor is always inside tmux's active pane (including
        // in copy-mode), so target its cell instead. Without tmux the
        // coordinates are irrelevant: xterm just scrolls its own viewport.
        const wheelPoint = (): { x: number; y: number } | null => {
            const screen = (terminal.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? null;
            const rect = (screen ?? terminal.element)?.getBoundingClientRect();
            if (!rect) return null;
            if (terminal.cols <= 0 || terminal.rows <= 0) {
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            const cw = rect.width / terminal.cols;
            const ch = rect.height / terminal.rows;
            const buf = terminal.buffer.active;
            // cursorY is relative to baseY, not to what is currently scrolled
            // into view; convert to an on-screen row before mapping to pixels.
            const col = Math.min(Math.max(buf.cursorX, 0), terminal.cols - 1);
            const row = Math.min(Math.max(buf.baseY + buf.cursorY - buf.viewportY, 0), terminal.rows - 1);
            return { x: rect.left + (col + 0.5) * cw, y: rect.top + (row + 0.5) * ch };
        };
        const dispatchWheel = (deltaY: number) => {
            const el = terminal.element;
            if (!el) return;
            const pt = wheelPoint();
            if (!pt) return;
            el.dispatchEvent(
                new WheelEvent('wheel', {
                    deltaY,
                    deltaMode: 0,
                    clientX: pt.x,
                    clientY: pt.y,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        };

        // File paste and drag-drop.
        //
        // Reads ClipboardEvent.clipboardData rather than navigator.clipboard
        // .read(): the async Clipboard API requires a secure context, and this
        // UI is routinely served over plain HTTP on a LAN IP, where it simply
        // isn't available. The paste event carries the same bytes with no
        // permission prompt, and also covers mobile long-press-paste.
        const filesFrom = (dt: DataTransfer | null | undefined): File[] => {
            const files: File[] = [];
            for (const item of Array.from(dt?.items ?? [])) {
                if (item.kind !== 'file') continue;
                const file = item.getAsFile();
                if (file) files.push(file);
            }
            // Fallback for browsers that populate .files but not .items on a
            // paste (older Safari).
            if (files.length === 0) files.push(...Array.from(dt?.files ?? []));
            return files;
        };
        const hasFiles = (dt: DataTransfer | null | undefined): boolean =>
            !!dt && (Array.from(dt.types ?? []).includes('Files') || dt.files?.length > 0);
        // trzsz, when the deployment turns it on, installs its own drop
        // handler on the terminal element and forwards dropped files to `trz`
        // on the *remote* side. That is a different destination the operator
        // asked for explicitly, so it keeps drops; uploading to the host is
        // the behaviour everywhere else (trzsz is off by default).
        const dropHandledHere = () => this.isActive() && !this.trzszEnabled;

        // A drag with no feedback is indistinguishable from a drag the page
        // will refuse, so say plainly that dropping here uploads. dragleave
        // fires on every element boundary crossed, hence the depth counter
        // rather than a boolean.
        let dragDepth = 0;
        let dropHint: HTMLElement | null = null;
        const showDropHint = () => {
            if (dropHint || !dropHandledHere()) return;
            dropHint = document.createElement('div');
            dropHint.textContent = 'Drop to upload to this host';
            dropHint.style.cssText = `position:fixed;inset:0;z-index:2147483646;display:flex;
align-items:center;justify-content:center;pointer-events:none;font:600 1.25rem/1.4 system-ui,sans-serif;
color:#f0f0f0;background:rgba(16,16,16,0.55);border:3px dashed rgba(240,240,240,0.7);box-sizing:border-box;`;
            document.body.appendChild(dropHint);
        };
        const hideDropHint = () => {
            dragDepth = 0;
            dropHint?.remove();
            dropHint = null;
        };

        // These listeners live on `document`, so with several tabs mounted at
        // once every terminal would otherwise react to the same paste/drop.
        // Only the active tab (the one owning window.term) should consume it.
        const onPaste = (e: ClipboardEvent) => {
            if (!this.isActive()) return;
            const files = filesFrom(e.clipboardData);
            if (files.length === 0) return; // text paste — leave xterm's own handling alone
            e.preventDefault();
            void this.pasteFiles(files);
        };
        // Capture phase, and propagation stopped once taken: the drop must not
        // also reach the trzsz listener on the terminal element below.
        const onDrop = (e: DragEvent) => {
            hideDropHint();
            if (!dropHandledHere()) return;
            const files = filesFrom(e.dataTransfer);
            if (files.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            void this.pasteFiles(files);
        };
        // Without cancelling dragover the browser navigates away to the file.
        const onDragOver = (e: DragEvent) => {
            if (!hasFiles(e.dataTransfer)) return;
            e.preventDefault();
            if (!dropHandledHere()) return;
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const onDragEnter = (e: DragEvent) => {
            if (!hasFiles(e.dataTransfer)) return;
            dragDepth++;
            showDropHint();
        };
        const onDragLeave = (e: DragEvent) => {
            if (!hasFiles(e.dataTransfer)) return;
            if (--dragDepth <= 0) hideDropHint();
        };

        document.addEventListener('paste', onPaste);
        document.addEventListener('drop', onDrop, true);
        document.addEventListener('dragover', onDragOver, true);
        document.addEventListener('dragenter', onDragEnter, true);
        document.addEventListener('dragleave', onDragLeave, true);
        this.register({
            dispose: () => {
                hideDropHint();
                document.removeEventListener('paste', onPaste);
                document.removeEventListener('drop', onDrop, true);
                document.removeEventListener('dragover', onDragOver, true);
                document.removeEventListener('dragenter', onDragEnter, true);
                document.removeEventListener('dragleave', onDragLeave, true);
            },
        });

        const prevHook = window.ttyd?.vkbdHook;
        this.bridge = {
            sendBytes: data => this.sendData(data),
            pasteFiles: files => this.pasteFiles(files),
            pasteImage: blob => this.pasteImage(blob),
            scrollLines: n => dispatchWheel(n * getRowHeight()),
            scrollPages: n => {
                const vp = getViewport();
                const h = vp ? vp.clientHeight : getRowHeight() * terminal.rows;
                dispatchWheel(n * h);
            },
            scrollToBottom: () => {
                const vp = getViewport();
                if (vp) vp.scrollTop = vp.scrollHeight;
                else terminal.scrollToBottom();
            },
            paste: async () => {
                try {
                    const txt = await navigator.clipboard.readText();
                    if (txt) this.sendData(txt);
                } catch (e) {
                    console.warn('[ttyd] paste failed', e);
                }
            },
            copySelection: async () => {
                // Use last known selection so copy still works if terminal
                // output arrived after the selection was made.
                const sel = terminal.getSelection() || this.lastSel;
                if (!sel) return;
                try {
                    await this.doCopy(sel);
                    this.overlayAddon?.showOverlay('✂', 300);
                } catch (e) {
                    console.warn('[ttyd] copy failed', e);
                }
            },
            setSelectMode: on => this.setSelectMode(on),
            focus: () => terminal.focus(),
            vkbdHook: prevHook,
        };

        this.setupAutoReconnect();
    }

    // Make this terminal the active one: point the window.term / window.ttyd
    // singletons (which the virtual keyboard and paste/copy paths read) at this
    // instance, preserving the vkbd hook across the swap so modifier state and
    // the input bar keep working after a tab switch. Called by the Terminal
    // component whenever its tab becomes active.
    @bind
    public activate() {
        if (!this.terminal || !this.bridge) return;
        const prevHook = window.ttyd?.vkbdHook;
        window.term = this.terminal as TtydTerminal;
        window.term.fit = () => this.safeFit();
        this.bridge.vkbdHook = prevHook;
        window.ttyd = this.bridge;
        // The pane was display:none until now, so xterm measured 0×0 and never
        // fit. Now that it's visible, re-fit to the real geometry.
        this.safeFit();
        const coarse = window.matchMedia?.('(pointer: coarse)').matches;
        // Never steal focus from an editable field outside the terminal. A tab
        // switch is exactly when the tab-rename box opens (its first click
        // selects the tab, the second opens the box), so focusing here would
        // blur the box the instant it appeared — the rename would silently
        // close and only the tab switch would be visible.
        if (!coarse && !this.editingOutside()) this.terminal.focus();
    }

    // Is the keyboard currently owned by an editable element that is not part of
    // this terminal (tab rename box, vkbd input bar, …)?
    private editingOutside(): boolean {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return false;
        if (this.terminal?.element?.contains(el)) return false;
        return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    }

    // Is this instance the one currently owning the window singletons?
    private isActive(): boolean {
        return !!this.terminal && window.term === (this.terminal as TtydTerminal);
    }

    // Auto-reconnect when the page becomes visible again. On mobile
    // (iOS/Android) backgrounding the browser or locking the screen freezes
    // the page and tears down the WebSocket — often with an `error` event
    // first, which clears doReconnect, so the normal close path lands on the
    // "Press ⏎ to Reconnect" prompt that's awkward to trigger on a phone.
    // Listening for visibility/focus/pageshow/online lets us reconnect the
    // moment the user returns to the tab, with no keypress needed. Registered
    // once and intentionally kept for the page lifetime — it must survive the
    // per-socket dispose() that runs on every reconnect.
    @bind
    private setupAutoReconnect() {
        if (this.autoReconnectSetup) return;
        this.autoReconnectSetup = true;

        const resume = () => {
            if (document.visibilityState !== 'visible') return;
            if (!this.opened) return;
            // Respect explicit opt-outs.
            if (!this.reconnect || this.closeOnDisconnect) return;
            // A reconnect is already in flight, or the socket is still healthy.
            if (this.reconnecting) return;
            const rs = this.socket?.readyState;
            if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
            console.log('[ttyd] page visible, socket not open — auto-reconnecting');
            this.startReconnect();
        };

        this.resumeDisposables.push(
            addEventListener(document, 'visibilitychange', resume),
            addEventListener(window, 'pageshow', resume),
            addEventListener(window, 'focus', resume),
            addEventListener(window, 'online', resume),
        );
    }

    @bind
    private startReconnect() {
        this.reconnecting = true;
        this.doReconnect = true;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;
        this.overlayAddon.showOverlay('Reconnecting...');
        this.dispose();
        void this.refreshToken().then(this.connect);
    }

    @bind
    private initListeners() {
        const { terminal, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                if (data && data !== '') {
                    this.processTitle = data;
                    // The OSC-0 title (session/agent name from the wrapper) is
                    // the best tab label — bubble it regardless of which tab is
                    // active. Only the active tab owns the document title.
                    this.onTitle?.(data);
                    if (!this.titleFixed && this.isActive()) {
                        document.title = data + ' | ' + this.title;
                    }
                }
            }),
        );
        register(terminal.onData(data => sendData(data)));
        register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            }),
        );
        register(
            terminal.onSelectionChange(() => {
                const sel = this.terminal.getSelection();
                if (!sel) {
                    this.lastSel = '';
                    this.hideSelTip();
                    return;
                }
                this.lastSel = sel;
                const lines = sel.split('\n').length;
                this.overlayAddon?.showOverlay(`${sel.length}c/${lines}L \u2702`, 1200);
                this.showSelTip(sel);
            }),
        );
        register(addEventListener(window, 'resize', () => this.safeFit()));
        register(addEventListener(window, 'beforeunload', this.onWindowUnload));
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                if (this.pending < lowWater) {
                    this.socket?.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater) {
                this.socket?.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public sendData(data: string | Uint8Array) {
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    // Make the next connect() ask ttyd-session.sh to recreate the session
    // (`arg=restart`). One-shot by construction: connect() clears it as it
    // builds the socket, so the reconnects that follow — startReconnect() after
    // a drop, the visibility/online resume — attach to the recreated session
    // instead of killing it again.
    public restartOnNextConnect() {
        this.restartNext = true;
    }

    @bind
    public connect() {
        const restart = this.restartNext;
        this.restartNext = false;
        this.socket = new WebSocket(restart ? withRestartArg(this.options.wsUrl) : this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        register(addEventListener(socket, 'open', this.onSocketOpen));
        register(addEventListener(socket, 'message', this.onSocketData as EventListener));
        register(addEventListener(socket, 'close', this.onSocketClose as EventListener));
        register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        this.reconnecting = false;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;

        const { textEncoder, terminal, overlayAddon } = this;
        const msg = JSON.stringify({ AuthToken: this.token, columns: terminal.cols, rows: terminal.rows });
        this.socket?.send(textEncoder.encode(msg));

        if (this.opened) {
            terminal.reset();
            terminal.options.disableStdin = false;
            overlayAddon.showOverlay('Reconnected', 300);
        } else {
            this.opened = true;
        }

        this.doReconnect = this.reconnect;
        this.initListeners();
        // On coarse-pointer devices (mobile), focusing the helper textarea
        // pops up the OS keyboard. Reconnects happen often on flaky mobile
        // networks, so don't auto-focus there — the user can tap the
        // terminal to bring up the keyboard when they actually want it.
        const coarse = window.matchMedia?.('(pointer: coarse)').matches;
        if (!coarse) terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const { overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.reconnecting = false;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;
        this.dispose();

        // 1000: CLOSE_NORMAL
        if (event.code !== 1000 && this.doReconnect) {
            this.startReconnect();
        } else if (this.closeOnDisconnect) {
            window.close();
        } else {
            // No auto-reconnect (normal close, or doReconnect was cleared by a
            // socket error). Offer a manual reconnect on Enter, but leave
            // `reconnecting` false so the visibility handler can still take over
            // when the user returns to a backgrounded mobile tab.
            const { terminal } = this;
            this.pendingReconnectKey = terminal.onKey(e => {
                if (e.domEvent.key === 'Enter') this.startReconnect();
            });
            overlayAddon.showOverlay('Press ⏎ to Reconnect');
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const { terminal } = this;
        const { clientOptions } = this.options;
        const prefs = {} as Preferences;
        const queryObj = Array.from(new URLSearchParams(query) as unknown as Iterable<[string, string]>);

        for (const [k, queryVal] of queryObj) {
            let v = clientOptions[k];
            if (v === undefined) v = terminal.options[k];
            switch (typeof v) {
                case 'boolean':
                    prefs[k] = queryVal === 'true' || queryVal === '1';
                    break;
                case 'number':
                case 'bigint':
                    prefs[k] = Number.parseInt(queryVal, 10);
                    break;
                case 'string':
                    prefs[k] = queryVal;
                    break;
                case 'object':
                    prefs[k] = JSON.parse(queryVal);
                    break;
                default:
                    console.warn(`[ttyd] maybe unknown option: ${k}=${queryVal}, treating as string`);
                    prefs[k] = queryVal;
                    break;
            }
        }

        return prefs;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
                this.writeFunc(data);
                break;
            case Command.SET_WINDOW_TITLE:
                // The server's opening banner: `<launch command> (<hostname>)`,
                // built once in protocol.c from ttyd's own argv. It is identical
                // for every socket, so it must NOT reach the tab chip — it would
                // stamp all tabs in a group with the same "tmux new -A -s main
                // (host)" and bury the session name the URL asked for. Only the
                // wrapper's per-session OSC-0 title labels a chip (see
                // initListeners). Kept as the document-title suffix.
                this.title = textDecoder.decode(data);
                if (this.isActive()) document.title = this.title;
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, register } = this;
        // Remembered because trzsz installs its own drop handler on the
        // terminal element; see the drop listener in open().
        this.trzszEnabled = !!prefs.enableTrzsz;
        if (prefs.enableZmodem || prefs.enableTrzsz) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data => this.zmodemAddon?.consume(data);
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of Object.entries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        window.removeEventListener('beforeunload', this.onWindowUnload);
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        terminal.loadAddon(register(new ImageAddon()));
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'closeOnDisconnect':
                    if (value) {
                        console.log('[ttyd] close on disconnect enabled (Reconnect disabled)');
                        this.closeOnDisconnect = true;
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'titleFixed':
                    if (!value || value === '') return;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    document.title = value;
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    if (key === 'fontSize') {
                        const vkbd = loadVkbdSettings();
                        if (vkbd.termFontSize) {
                            console.log(`[ttyd] skipping server fontSize=${value}, user override=${vkbd.termFontSize}`);
                            break;
                        }
                    }
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) this.safeFit();
                    break;
            }
        }
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeCanvasRenderer = () => {
            try {
                this.canvasAddon?.dispose();
            } catch {
                // ignore
            }
            this.canvasAddon = undefined;
        };
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableCanvasRenderer = () => {
            if (this.canvasAddon) return;
            this.canvasAddon = new CanvasAddon();
            disposeWebglRenderer();
            try {
                this.terminal.loadAddon(this.canvasAddon);
                console.log('[ttyd] canvas renderer loaded');
            } catch (e) {
                console.log('[ttyd] canvas renderer could not be loaded, falling back to dom renderer', e);
                disposeCanvasRenderer();
            }
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            disposeCanvasRenderer();
            try {
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon?.dispose();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to canvas renderer', e);
                disposeWebglRenderer();
                enableCanvasRenderer();
            }
        };

        switch (value) {
            case 'canvas':
                enableCanvasRenderer();
                break;
            case 'webgl':
                enableWebglRenderer();
                break;
            case 'dom':
                disposeWebglRenderer();
                disposeCanvasRenderer();
                console.log('[ttyd] dom renderer loaded');
                break;
            default:
                break;
        }
    }
}
