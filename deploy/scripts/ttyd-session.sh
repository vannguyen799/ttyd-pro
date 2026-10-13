#!/bin/bash
# ══════════════════════════════════════════════════════════════
# ttyd session wrapper — auto-attach to tmux or screen
# ══════════════════════════════════════════════════════════════
#
# Invoked by ttyd with URL args passed as positional args.
# Accessed via: http://host:port/?arg=<part1>&arg=<part2>
#
# Args are parsed as:
#   [modifier]... [session-type] [name]
#
# Modifiers (any order, before the session spec):
#   cwd:<path>            chdir to <path> before launching the session
#   name:<session>        explicit session name (takes precedence over the
#                         positional name; order-independent like cwd:).
#                         Use this to avoid the positional name being confused
#                         with the `tmux`/`screen` session-type keyword, and to
#                         guarantee every terminal gets a unique session instead
#                         of falling back to the shared default "main".
#   codex                 run `codex` (no args) on first-create
#   codex:<args>          run `codex <args>` on first-create. <args> is
#                         parsed with shell-style quoting (single/double
#                         quotes preserve spaces), then %q-escaped for
#                         safe embedding. The server does NOT inject any
#                         default flags; the caller is responsible for
#                         passing any required sandbox/approval flags.
#   claude                run `claude` (no args) on first-create
#   claude:<args>         run `claude <args>` on first-create
#   idle:<spec>           per-session reap threshold (3d, 12h, 90m, seconds),
#                         overriding the reaper's default for this session only.
#                         Sticky: set once, it survives later opens of the same
#                         name that do not pass idle: again.
#   noreap                never reap this session, whatever its idle time
#
# Session spec (optional — default = tmux main):
#   (none)                tmux new -A -s main
#   <name>                tmux new -A -s <name>
#   tmux <name>           tmux new -A -s <name>
#   screen <name>         screen -xRR <name>   (agent modifier ignored)
#
# Examples:
#   ?arg=dev                              tmux "dev"
#   ?arg=codex&arg=crm                    tmux "crm", codex on first-create
#   ?arg=codex:--help&arg=crm             tmux "crm", codex --help
#   ?arg=cwd:/home/user/MetrixCRM&arg=codex&arg=crm
#                                         cd + tmux "crm" + codex on first-create
#   ?arg=screen&arg=build                 screen "build"
#   ?arg=idle:1h&arg=name=scratch         tmux "scratch", reaped after 1h idle
#   ?arg=noreap&arg=name:build-box        tmux "build-box", never reaped
#
# Notes:
#   • First-create vs attach: if the tmux session already exists, we attach
#     only — the agent CLI will NOT be re-run.
#   • <path> must be an existing directory; otherwise a warning is logged
#     and the wrapper keeps ttyd's launch cwd.
#   • A new claude session is given an explicit --session-id so the
#     persistence layer can resume that exact conversation after a reboot
#     (see resurrect-agent-hook.sh).
#   • Session names are sanitized: only [A-Za-z0-9._-], max 64 chars.
#   • Every session this wrapper attaches to is registered under
#     $STATE/sessions/<name>. The idle reaper only ever touches sessions in
#     that registry, so tmux sessions started by anything else are left alone.
#   • Agent args are split on whitespace then %q-quoted to prevent
#     injection into the tmux shell command.
# ══════════════════════════════════════════════════════════════

set -u

# Keep user-installed agent CLIs discoverable even when ttyd was started by a
# service with a minimal PATH.
if [ -n "${HOME:-}" ]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

# Backward compatibility for browser tabs that still have the pre-upgrade UI
# loaded: those clients send Claude's Ctrl+V action after upload. New clients
# use Claude's @file syntax and never invoke this helper.
LIBEXEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../libexec" && pwd)"

# Parked sessions. ttyd-reap-idle.sh snapshots a session before closing it, so
# a name with no live tmux session may still have one on disk waiting to be
# rebuilt (see ttyd-snapshot.sh).
SNAPSHOT_TOOL="$(dirname "${BASH_SOURCE[0]}")/ttyd-snapshot.sh"

# Registry of sessions this wrapper owns, one file per session name.
#
# The idle reaper only ever touches sessions listed here, so a tmux session
# started by something else — the gateway's `claude setup-token` window, a
# hand-rolled `tmux new` at an SSH prompt — is never closed out from under its
# owner.
#
# A file rather than only a tmux option, because tmux-resurrect does not save
# session options: after a reboot it rebuilds every session and an
# `@ttyd-pro` marker set at creation is simply gone, which would quietly
# exempt every restored session from reaping forever. The file survives that,
# and carries the per-session `idle:`/`noreap` settings for the same reason.
STATE_DIR="${TTYD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ttyd}"
OWNED_DIR="$STATE_DIR/sessions"

SHELL_CMD="${SHELL:-/bin/bash}"

sanitize() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-64
}

fallback_shell() {
    exec "$SHELL_CMD"
}

# A lowercase RFC-4122 UUID, or nothing when the host offers no generator.
# Only ever fed to a flag we control, and validated anyway so a surprising
# generator can't inject a second token into the tmux command string.
new_uuid() {
    local id=""
    if [ -r /proc/sys/kernel/random/uuid ]; then
        read -r id < /proc/sys/kernel/random/uuid
    elif command -v uuidgen >/dev/null 2>&1; then
        id="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
    fi
    case "$id" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
            printf '%s' "$id"
            ;;
    esac
}

# ── Parse modifiers ──────────────────────────────────────────
AGENT_ENABLED=0
AGENT_CMD=""
AGENT_ARGS=""
NAME=""
NAME_EXPLICIT=0
IDLE_SPEC=""
NO_REAP=0
CWD_SET=0

while [ $# -gt 0 ]; do
    case "$1" in
        name:*)
            NAME="${1#name:}"
            NAME_EXPLICIT=1
            shift
            ;;
        idle:*)
            # Per-session reap threshold, overriding the reaper's default.
            IDLE_SPEC="${1#idle:}"
            shift
            ;;
        noreap)
            NO_REAP=1
            shift
            ;;
        cwd:*)
            REQ_DIR="${1#cwd:}"
            shift
            if [ -z "$REQ_DIR" ]; then
                echo "warn: empty cwd arg, staying in $(pwd)" >&2
            else
                if [ ! -d "$REQ_DIR" ]; then
                    if mkdir -p "$REQ_DIR" 2>/dev/null; then
                        echo "info: created cwd '$REQ_DIR'" >&2
                    else
                        echo "warn: could not create '$REQ_DIR', staying in $(pwd)" >&2
                    fi
                fi
                if [ -d "$REQ_DIR" ]; then
                    if cd "$REQ_DIR"; then
                        CWD_SET=1
                    else
                        echo "warn: cd '$REQ_DIR' failed, staying in $(pwd)" >&2
                    fi
                fi
            fi
            ;;
        codex)
            AGENT_ENABLED=1
            AGENT_CMD="codex"
            AGENT_ARGS=""
            shift
            ;;
        codex:*)
            AGENT_ENABLED=1
            AGENT_CMD="codex"
            AGENT_ARGS="${1#codex:}"
            shift
            ;;
        claude)
            AGENT_ENABLED=1
            AGENT_CMD="claude"
            AGENT_ARGS=""
            shift
            ;;
        claude:*)
            AGENT_ENABLED=1
            AGENT_CMD="claude"
            AGENT_ARGS="${1#claude:}"
            shift
            ;;
        *)
            break
            ;;
    esac
done

# ── Determine session type + name ────────────────────────────
# An explicit `name:` modifier always wins; the positional name is only used
# as a fallback when no `name:` was given (backward compat).
MODE="tmux"
case "${1:-}" in
    "")
        ;;
    screen)
        MODE="screen"
        [ "$NAME_EXPLICIT" = 0 ] && NAME="${2:-}"
        ;;
    tmux)
        MODE="tmux"
        [ "$NAME_EXPLICIT" = 0 ] && NAME="${2:-}"
        ;;
    *)
        [ "$NAME_EXPLICIT" = 0 ] && NAME="$1"
        ;;
esac

NAME="$(sanitize "$NAME")"
[ -z "$NAME" ] && NAME="main"

# Title shown in browser tab (document.title) + tmux set-titles-string.
TITLE="$NAME"
TMUX_TITLES_STRING='#{?#{==:#{pane_current_command},claude},#S - CLAUDE,#{?#{==:#{pane_current_command},codex},#S - CODEX,#S}}'
if [ "$AGENT_ENABLED" = 1 ]; then
    AGENT_LABEL="$(printf '%s' "$AGENT_CMD" | tr '[:lower:]' '[:upper:]')"
    TITLE="$NAME - $AGENT_LABEL"
fi

# Emit OSC-0 so xterm.js (ttyd frontend) picks up browser-tab title.
set_browser_title() {
    printf '\033]0;%s\007' "$1"
}

# ── Dispatch ─────────────────────────────────────────────────
if [ "$MODE" = "screen" ]; then
    if ! command -v screen >/dev/null 2>&1; then
        echo "screen not installed, falling back to shell" >&2
        fallback_shell
    fi
    if [ "$AGENT_ENABLED" = 1 ]; then
        echo "warn: agent modifier is ignored for screen sessions" >&2
        TITLE="$NAME"
    fi
    set_browser_title "$TITLE"
    exec screen -xRR "$NAME"
fi

# tmux path
if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not installed, falling back to shell" >&2
    fallback_shell
fi

# Exact-match target. tmux resolves a bare `-t name` as exact → prefix →
# fnmatch, so `-t foo` would attach to an existing `foo-bar` session. The
# leading `=` forces an exact-name match, otherwise two sessions where one
# name is a prefix of the other (e.g. "crm" vs "crm-terminal") collide.
TGT="=$NAME"

# Claim the session for ttyd-pro and record its reap settings.
#
# Called on every path that reaches an attach — create, plain attach, and
# snapshot restore alike — because ownership has to survive a tmux server
# restart that rebuilt the session behind our back, and because a URL carrying
# a new `idle:` should update a session that already exists.
#
# `idle:` and `noreap` are only written when the URL actually asked for them:
# reopening a session with a bare `?arg=name:x` must not silently clear a
# threshold set earlier.
mark_owned() {
    mkdir -p "$OWNED_DIR" 2>/dev/null || return 0

    local file="$OWNED_DIR/$NAME" prev_idle="" prev_noreap=""
    if [ -f "$file" ]; then
        while IFS='=' read -r k v; do
            case "$k" in
                idle) prev_idle="$v" ;;
                noreap) prev_noreap="$v" ;;
            esac
        done <"$file"
    fi

    [ -n "$IDLE_SPEC" ] && prev_idle="$IDLE_SPEC"
    [ "$NO_REAP" = 1 ] && prev_noreap=1

    {
        printf 'owner=ttyd-pro\n'
        printf 'name=%s\n' "$NAME"
        printf 'seen=%s\n' "$(date +%s)"
        printf 'idle=%s\n' "$prev_idle"
        printf 'noreap=%s\n' "${prev_noreap:-0}"
    } >"$file" 2>/dev/null

    # Mirror onto the session itself so `tmux show-options` and the gateway's
    # runtime panel can see the same thing without reading our state directory.
    #
    # The trailing colon is load-bearing, not a typo: `set-option -t =name`
    # fails with "no such session" even where `has-session -t =name` succeeds,
    # because set-option resolves its target as a session only once the name
    # looks like one. `=name:` keeps the exact-match `=` and parses. (The
    # set-titles calls above never hit this — `-g` makes them global and the
    # target is ignored.)
    tmux set-option -t "$TGT:" @ttyd-pro 1 2>/dev/null
    [ -n "$prev_idle" ] && tmux set-option -t "$TGT:" @ttyd-idle "$prev_idle" 2>/dev/null
    [ "${prev_noreap:-0}" = 1 ] && tmux set-option -t "$TGT:" @ttyd-no-reap 1 2>/dev/null
    return 0
}

# Attach to a session that already exists, without re-running the agent CLI.
# Never returns.
attach_existing() {
    # The saved browser route describes how the session was first created, not
    # necessarily what its pane runs today. Reflect the actual foreground
    # agent in OSC/title updates so image delivery cannot confuse Codex with
    # Claude after a user switches tools inside an existing session.
    CURRENT_COMMAND="$(tmux list-panes -t "$TGT" -F '#{pane_current_command}' 2>/dev/null | head -n 1)"
    case "$CURRENT_COMMAND" in
        claude|codex)
            CURRENT_LABEL="$(printf '%s' "$CURRENT_COMMAND" | tr '[:lower:]' '[:upper:]')"
            TITLE="$NAME - $CURRENT_LABEL"
            ;;
        *) TITLE="$NAME" ;;
    esac
    tmux set-option -t "$TGT" -g set-titles on 2>/dev/null
    tmux set-option -t "$TGT" -g set-titles-string "$TMUX_TITLES_STRING" 2>/dev/null
    mark_owned
    set_browser_title "$TITLE"
    # An explicit cwd: re-points the session's working directory, which is
    # where its new windows open. Without it the session keeps the cwd it was
    # first created (or restored) with, so a route whose cwd: has since changed
    # would still open new windows in the old directory.
    if [ "$CWD_SET" = 1 ]; then
        exec tmux attach-session -t "$TGT" -c "$PWD"
    fi
    exec tmux attach-session -t "$TGT"
}

# Existing session → always just attach.
if tmux has-session -t "$TGT" 2>/dev/null; then
    attach_existing
fi

# No live session under this name — but the reaper may have parked one here.
# Rebuilding it is what closes the loop: the browser asks for the same name it
# used before and gets back its windows, working directories, scrollback and
# agent conversations, instead of the blank shell a plain `new-session` would
# hand over. A snapshot that fails to restore is not fatal; fall through and
# create the session fresh rather than leaving the user with no terminal.
if [ -x "$SNAPSHOT_TOOL" ] && "$SNAPSHOT_TOOL" has "$NAME"; then
    printf 'restoring saved session %s...\n' "$NAME" >&2
    if "$SNAPSHOT_TOOL" restore "$NAME" >/dev/null 2>&1 && tmux has-session -t "$TGT" 2>/dev/null; then
        attach_existing
    fi
    echo "warn: could not restore the snapshot for '$NAME', starting a fresh session" >&2
fi

# Brand-new session.
if [ "$AGENT_ENABLED" = 1 ]; then
    if ! command -v "$AGENT_CMD" >/dev/null 2>&1; then
        echo "$AGENT_CMD CLI not found, creating plain tmux session" >&2
        tmux new-session -d -s "$NAME"
    else
        # Append user args (split on whitespace, then %q-quoted) so the
        # session runs the selected CLI safely in a shell-expansion context.
        quoted=""
        if [ -n "$AGENT_ARGS" ]; then
            # Parse args respecting shell-style quoting (`-p "hello world"`
            # stays as two tokens `-p` and `hello world`) using xargs -n1,
            # then %q-quote each token for safe embedding.
            while IFS= read -r tok; do
                [ -z "$tok" ] && continue
                quoted+="$(printf ' %q' "$tok")"
            done < <(printf '%s\n' "$AGENT_ARGS" | xargs -n1 2>/dev/null)
        fi
        # Pin the conversation id of a brand-new claude pane. Claude Code lets
        # the id be chosen up front, and knowing it is what makes the pane
        # restorable: resurrect-agent-hook.sh rewrites the saved
        # `--session-id <id>` into `--resume <id>`, so a reboot brings the pane
        # back into *this* conversation instead of an empty one. Skipped when
        # the caller already picked a session (`claude:--resume …`, `claude:-c`)
        # or when no source of UUIDs is available.
        if [ "$AGENT_CMD" = "claude" ]; then
            case " $AGENT_ARGS " in
                *" --session-id"* | *" --resume"* | *" -r "* | *" -c "* | *" --continue"*) ;;
                *)
                    SESSION_UUID="$(new_uuid)"
                    [ -n "$SESSION_UUID" ] && quoted+=" --session-id $SESSION_UUID"
                    ;;
            esac
        fi
        AGENT_LAUNCH="$AGENT_CMD"
        if [ "$AGENT_CMD" = "claude" ] && [ -x "$LIBEXEC_DIR/xclip" ]; then
            AGENT_PATH="$(printf '%q' "$LIBEXEC_DIR:$PATH")"
            AGENT_LAUNCH="env PATH=$AGENT_PATH claude"
        fi
        tmux new-session -d -s "$NAME" \
            "$AGENT_LAUNCH${quoted}; exec $SHELL_CMD"
    fi
else
    tmux new-session -d -s "$NAME"
fi

tmux set-option -t "$TGT" -g set-titles on 2>/dev/null
tmux set-option -t "$TGT" -g set-titles-string "$TMUX_TITLES_STRING" 2>/dev/null
mark_owned
set_browser_title "$TITLE"
exec tmux attach-session -t "$TGT"
