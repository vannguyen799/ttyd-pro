import type { KeyGroup } from './types';

// tmux prefix is Ctrl-b (\x02). These combos drive tmux's default key
// table — splits via %/", resize via prefix+Ctrl-arrow (repeatable),
// and an explicit :kill-pane command so closing works without the
// y/n confirm prompt (which has no key on a touch keyboard).
const TMUX = '\x02';

// Type a command and press Enter in one tap. `send` writes the literal
// bytes (unaffected by active modifiers), and the trailing \r submits —
// this is the "emit text + enter" pattern most agent shortcuts use.
const cmd = (text: string): { type: 'send'; bytes: string } => ({ type: 'send', bytes: text + '\r' });

// Built-in keys are organised into named groups. Each group is a "level"
// that can be toggled on/off as a whole (and every key within it too).
// Group ids are stable — they key disabledGroups/disabledIds and are the
// targets custom buttons can be routed into, so don't rename them lightly.
export const GROUPS: KeyGroup[] = [
    {
        id: 'keys',
        title: 'Keys & arrows',
        rows: [
            {
                keys: [
                    { label: 'Esc', action: { type: 'named', key: 'esc' } },
                    { label: 'Tab', action: { type: 'named', key: 'tab' } },
                    { label: 'Ctrl', action: { type: 'mod', mod: 'ctrl' }, class: 'mod' },
                    {
                        label: '←',
                        sub: 'hold',
                        action: { type: 'named', key: 'left' },
                        class: 'arrow arrow-first',
                        repeat: true,
                    },
                    {
                        label: '↑',
                        sub: 'hold',
                        action: { type: 'named', key: 'up' },
                        class: 'arrow',
                        repeat: true,
                    },
                    {
                        label: '↓',
                        sub: 'hold',
                        action: { type: 'named', key: 'down' },
                        class: 'arrow',
                        repeat: true,
                    },
                    {
                        label: '→',
                        sub: 'hold',
                        action: { type: 'named', key: 'right' },
                        class: 'arrow',
                        repeat: true,
                    },
                ],
            },
        ],
    },
    {
        id: 'edit',
        title: 'Editing & signals',
        rows: [
            {
                keys: [
                    { label: 'Home', action: { type: 'named', key: 'home' } },
                    { label: 'End', action: { type: 'named', key: 'end' } },
                    { label: '⌫', sub: 'hold', action: { type: 'named', key: 'backspace' }, repeat: true },
                    { label: 'Del', action: { type: 'named', key: 'delete' } },
                    { label: '^C', sub: 'int', action: { type: 'send', bytes: '\x03' } },
                    { label: '^Z', sub: 'sus', action: { type: 'send', bytes: '\x1a' } },
                    { label: '📎', sub: 'file', action: { type: 'pasteimage' } },
                ],
            },
        ],
    },
    {
        id: 'fn',
        title: 'Scroll',
        rows: [
            {
                keys: [
                    {
                        label: '▲ Scroll',
                        sub: 'hold = auto',
                        action: { type: 'scroll', by: 'line', dir: -1 },
                        class: 'scroll',
                        flex: 2,
                    },
                    {
                        label: '▼ Scroll',
                        sub: 'hold = auto',
                        action: { type: 'scroll', by: 'line', dir: 1 },
                        class: 'scroll',
                        flex: 2,
                    },
                ],
            },
        ],
    },
    {
        // Claude Code shortcuts — each types the command and presses Enter.
        id: 'claude',
        title: 'Claude',
        rows: [
            {
                keys: [
                    {
                        label: 'claude',
                        sub: 'skip-perm',
                        action: cmd('claude --dangerously-skip-permissions'),
                        class: 'cmd',
                    },
                    { label: 'continue', sub: 'keep going', action: cmd('continue'), class: 'cmd' },
                    { label: '/resume', sub: 'session', action: cmd('/resume'), class: 'cmd' },
                    { label: '/rewind', sub: 'undo', action: cmd('/rewind'), class: 'cmd' },
                    { label: '/compact', sub: 'summarize', action: cmd('/compact'), class: 'cmd' },
                    { label: '/clear', sub: 'reset', action: cmd('/clear'), class: 'cmd' },
                    { label: 'opus', sub: '/model', action: cmd('/model opus'), class: 'cmd' },
                    { label: 'sonnet', sub: '/model', action: cmd('/model sonnet'), class: 'cmd' },
                    { label: '/effort', sub: 'think', action: cmd('/effort'), class: 'cmd' },
                    { label: '/commit', sub: 'git', action: cmd('/commit'), class: 'cmd' },
                    { label: '/exit', sub: 'quit', action: cmd('/exit'), class: 'cmd' },
                ],
            },
        ],
    },
    {
        // Codex shortcut, kept separate from Claude per its own launch flag.
        id: 'codex',
        title: 'Codex',
        rows: [
            {
                keys: [
                    {
                        label: 'codex',
                        sub: 'bypass',
                        action: cmd('codex --dangerously-bypass-approvals-and-sandbox'),
                        class: 'cmd danger',
                    },
                ],
            },
        ],
    },
    {
        id: 'tmux',
        title: 'tmux panes',
        tmuxOnly: true,
        rows: [
            {
                keys: [
                    {
                        // Jump to the end / live bottom by sending a plain Ctrl+End
                        // (CSI 1;5F) straight to the app — no tmux prefix. This is the
                        // key combo most TUIs and shells treat as "go to bottom".
                        label: '⏷ Last',
                        sub: 'Ctrl+End',
                        action: { type: 'send', bytes: '\x1b[1;5F' },
                        class: 'tmux',
                    },
                    {
                        label: '│',
                        sub: 'L | R',
                        action: { type: 'send', bytes: TMUX + '%' },
                        class: 'tmux',
                    },
                    {
                        label: '─',
                        sub: 'T / B',
                        action: { type: 'send', bytes: TMUX + '"' },
                        class: 'tmux',
                    },
                    {
                        // prefix `:` opens tmux's command prompt; the command must
                        // arrive in a *separate* write or tmux types it into the
                        // shell instead (mode switch needs an event-loop tick).
                        label: '✕ Pane',
                        sub: 'kill',
                        action: {
                            type: 'seq',
                            steps: [{ bytes: TMUX + ':' }, { bytes: 'kill-pane\r', delay: 80 }],
                        },
                        class: 'tmux danger',
                    },
                    {
                        label: '⇲←',
                        sub: 'size',
                        action: { type: 'send', bytes: TMUX + '\x1b[1;5D' },
                        class: 'tmux',
                        repeat: true,
                    },
                    {
                        label: '⇲↑',
                        sub: 'size',
                        action: { type: 'send', bytes: TMUX + '\x1b[1;5A' },
                        class: 'tmux',
                        repeat: true,
                    },
                    {
                        label: '⇲↓',
                        sub: 'size',
                        action: { type: 'send', bytes: TMUX + '\x1b[1;5B' },
                        class: 'tmux',
                        repeat: true,
                    },
                    {
                        label: '⇲→',
                        sub: 'size',
                        action: { type: 'send', bytes: TMUX + '\x1b[1;5C' },
                        class: 'tmux',
                        repeat: true,
                    },
                ],
            },
        ],
    },
];
