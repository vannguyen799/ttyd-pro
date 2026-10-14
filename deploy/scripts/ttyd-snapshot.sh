#!/bin/bash
# ══════════════════════════════════════════════════════════════
# ttyd-snapshot — per-session freeze/thaw for tmux sessions
# ══════════════════════════════════════════════════════════════
#
# tmux-resurrect already persists the tmux server, but it cannot persist a
# SESSION. Its save file is one global snapshot of every session at once
# (deploy/config/tmux-persist.conf), continuum overwrites it every 5 minutes,
# and `@continuum-restore` only fires when the tmux SERVER starts. Kill one
# idle session while the server keeps running and the next autosave rewrites
# the file without it — the session is gone from `last` for good, and there is
# no supported way to pull a single session back out of an older save.
#
# So the reaper needs its own store: one directory per session, written just
# before the kill and consumed by ttyd-session.sh the next time a browser asks
# for that name.
#
#   $STATE/snapshots/<session>/
#     layout                 window + pane lines, tmux-resurrect's own format
#     meta                   saved_at / idle_at_save / created / reason
#     panes/w<win>.p<pane>   scrollback captured at save time
#
# The layout file is deliberately resurrect's format, not one of our own:
# resurrect-agent-hook.sh already knows how to walk those 11 tab-separated
# fields and rewrite `claude --session-id <id>` into `claude --resume <id>`,
# which is the whole reason a restored agent pane comes back to its own
# conversation instead of an empty one. Reusing the format means reusing that
# logic verbatim instead of growing a second copy of it that can drift.
#
# What comes back:  window/pane layout, each pane's working directory, the
#                   scrollback as it looked at save time, whitelisted programs
#                   relaunched, and agent panes resumed into their transcript.
# What does not:    live process state. Same contract as a reboot — this is a
#                   snapshot of the screen, not a checkpoint of memory.
#
# Usage:
#   ttyd-snapshot.sh save <session> [reason]
#   ttyd-snapshot.sh restore <session>
#   ttyd-snapshot.sh has <session>          exit 0 when a snapshot exists
#   ttyd-snapshot.sh dir <session>          the directory the restored session
#                                           starts in (first window's first pane)
#   ttyd-snapshot.sh list
#   ttyd-snapshot.sh rm <session>
#   ttyd-snapshot.sh prune [days]           drop snapshots older than N days
#
# Environment:
#   TTYD_STATE_DIR              override the state root
#   TTYD_SNAPSHOT_SCROLLBACK    lines of scrollback per pane (default 5000)
#   TTYD_SNAPSHOT_KEEP_DAYS     default age for `prune` (default 30)
# ══════════════════════════════════════════════════════════════

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOOK="$SELF_DIR/resurrect-agent-hook.sh"

STATE_DIR="${TTYD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ttyd}"
SNAP_ROOT="$STATE_DIR/snapshots"
SCROLLBACK_LINES="${TTYD_SNAPSHOT_SCROLLBACK:-5000}"
KEEP_DAYS="${TTYD_SNAPSHOT_KEEP_DAYS:-30}"

TAB=$'\t'

die() {
    echo "ttyd-snapshot: $*" >&2
    exit 1
}

# Same rule as ttyd-session.sh, so a name that reached tmux through a URL maps
# to exactly one directory here and can never climb out of $SNAP_ROOT.
sanitize() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-64
}

snap_dir() {
    printf '%s/%s' "$SNAP_ROOT" "$1"
}

# tmux resolves a bare `-t name` as exact → prefix → fnmatch, so `-t foo` would
# happily act on `foo-bar`. The leading `=` pins it to the exact name.
tgt() {
    printf '=%s' "$1"
}

need_tmux() {
    command -v tmux >/dev/null 2>&1 || die "tmux not installed"
}

# Split a tab-separated line into the global array FIELDS, keeping empty fields.
# `read` with IFS=$'\t' cannot do this: tab is IFS *whitespace*, so bash
# collapses a run of tabs into one delimiter and every field after an empty one
# shifts left. An empty pane_title is enough to trigger it, and the pane index
# and pid then read out of the wrong columns — a silently corrupt snapshot.
# resurrect-agent-hook.sh documents the same trap for its own parsing.
FIELDS=()
split_tabs() {
    local fld
    FIELDS=()
    while IFS= read -r fld; do
        FIELDS+=("$fld")
    done < <(printf '%s\n' "$1" | tr '\t' '\n')
}

# One format field of one session, matched on the exact name. sanitize() has
# already stripped everything outside [A-Za-z0-9._-], so the name can never
# carry a brace that would break out of the filter expression.
session_field() {
    tmux list-sessions -f "#{==:#{session_name},$1}" -F "$2" 2>/dev/null | head -n 1
}

# ── save ─────────────────────────────────────────────────────

# The command a pane is actually running, as resurrect's `ps` strategy defines
# it: the direct child of the pane's shell. Resurrect greps `^$pane_pid` out of
# `ps -ao ppid,args`, which is a prefix match — pane pid 123 also matches a pane
# whose parent is 1234. awk on the whole field instead; same answer, minus the
# collision.
pane_full_command() {
    local pane_pid="$1"
    [ -n "$pane_pid" ] || return 0
    ps -eo ppid=,args= 2>/dev/null |
        awk -v p="$pane_pid" '{ ppid=$1; $1=""; sub(/^ /,""); if (ppid == p && $0 != "") { print; exit } }'
}

cmd_save() {
    local name="${1:-}" reason="${2:-manual}"
    [ -n "$name" ] || die "save: session name required"
    name="$(sanitize "$name")"
    [ -n "$name" ] || die "save: session name is empty after sanitizing"
    need_tmux

    tmux has-session -t "$(tgt "$name")" 2>/dev/null || die "save: no tmux session '$name'"

    mkdir -p "$SNAP_ROOT" || die "save: cannot create $SNAP_ROOT"

    # Build the snapshot in a scratch directory and swap it in at the end. A
    # save that dies halfway (tmux exits, disk fills) must not leave a partial
    # snapshot behind, because ttyd-session.sh treats any snapshot directory as
    # restorable and would rebuild the session from the truncated half.
    local tmp
    tmp="$(mktemp -d "$SNAP_ROOT/.tmp-$name.XXXXXX")" || die "save: cannot create scratch dir"
    # shellcheck disable=SC2064  # $tmp is expanded now on purpose
    trap "rm -rf '$tmp'" EXIT
    mkdir -p "$tmp/panes"

    # Window lines, resurrect's window_format (scripts/save.sh).
    tmux list-windows -t "$(tgt "$name")" -F \
        "window${TAB}#{session_name}${TAB}#{window_index}${TAB}:#{window_name}${TAB}#{window_active}${TAB}:#{window_flags}${TAB}#{window_layout}" \
        >"$tmp/layout" 2>/dev/null || die "save: could not list windows of '$name'"

    # Pane lines. resurrect's pane_format carries pane_pid and history_size in
    # place of the full command; it resolves the command in a second pass and
    # emits the 11-field line. Same two steps here, in one loop.
    local line win_idx win_active win_flags pane_idx pane_title dir pane_active pane_cmd pane_pid full esc_dir
    while IFS= read -r line; do
        split_tabs "$line"
        [ "${#FIELDS[@]}" -ge 9 ] || continue
        win_idx="${FIELDS[0]}"
        win_active="${FIELDS[1]}"
        win_flags="${FIELDS[2]}"
        pane_idx="${FIELDS[3]}"
        pane_title="${FIELDS[4]}"
        dir="${FIELDS[5]}"
        pane_active="${FIELDS[6]}"
        pane_cmd="${FIELDS[7]}"
        pane_pid="${FIELDS[8]}"
        [ -n "$pane_idx" ] || continue
        full="$(pane_full_command "$pane_pid")"
        # save.sh escapes spaces in the directory; the hook and our restore
        # both undo it, so the escaping has to match.
        esc_dir="${dir// /\\ }"
        printf 'pane\t%s\t%s\t%s\t%s\t%s\t%s\t:%s\t%s\t%s\t:%s\n' \
            "$name" "$win_idx" "$win_active" "$win_flags" "$pane_idx" \
            "$pane_title" "$esc_dir" "$pane_active" "$pane_cmd" "$full" \
            >>"$tmp/layout"

        # Scrollback. -e keeps the colour escapes so a replayed pane looks the
        # way it did; -S -N bounds the capture, since a pane with a huge
        # history-limit would otherwise dominate the snapshot.
        tmux capture-pane -ep -t "$(tgt "$name"):${win_idx}.${pane_idx}" -S "-${SCROLLBACK_LINES}" \
            2>/dev/null >"$tmp/panes/w${win_idx}.p${pane_idx}" || true
        # Trailing blank lines are most of a mostly-empty pane's capture.
        strip_trailing_blank "$tmp/panes/w${win_idx}.p${pane_idx}"
    done < <(tmux list-panes -s -t "$(tgt "$name")" -F \
        "#{window_index}${TAB}#{window_active}${TAB}:#{window_flags}${TAB}#{pane_index}${TAB}#{pane_title}${TAB}#{pane_current_path}${TAB}#{pane_active}${TAB}#{pane_current_command}${TAB}#{pane_pid}" \
        2>/dev/null)

    grep -q '^pane' "$tmp/layout" || die "save: session '$name' produced no pane lines"

    # Hand the layout to the agent hook so claude/codex panes are stored as
    # `--resume <id>` / `codex resume <id>`. Without this the restore relaunches
    # a blank agent and the conversation is the one thing the user actually
    # wanted back.
    if [ -x "$AGENT_HOOK" ]; then
        "$AGENT_HOOK" "$tmp/layout" || true
    fi

    {
        printf 'session=%s\n' "$name"
        printf 'saved_at=%s\n' "$(date +%s)"
        printf 'saved_at_iso=%s\n' "$(date -Is)"
        printf 'reason=%s\n' "$reason"
        # list-sessions -f, not `display-message -t =name`: display-message
        # resolves its target as a pane and hands back an empty string for a
        # session-only target, so the timestamps would silently save as blank.
        printf 'created=%s\n' "$(session_field "$name" '#{session_created}')"
        printf 'activity=%s\n' "$(session_field "$name" '#{session_activity}')"
        printf 'windows=%s\n' "$(grep -c '^window' "$tmp/layout")"
        printf 'panes=%s\n' "$(grep -c '^pane' "$tmp/layout")"
        printf 'scrollback_lines=%s\n' "$SCROLLBACK_LINES"
    } >"$tmp/meta"

    local dest
    dest="$(snap_dir "$name")"
    rm -rf "$dest.old"
    [ -d "$dest" ] && mv "$dest" "$dest.old"
    if mv "$tmp" "$dest"; then
        trap - EXIT
        rm -rf "$dest.old"
    else
        # Put the previous snapshot back rather than leaving the name bare.
        [ -d "$dest.old" ] && mv "$dest.old" "$dest"
        die "save: could not install snapshot at $dest"
    fi

    echo "saved $name ($(grep -c '^window' "$dest/layout") windows, $(grep -c '^pane' "$dest/layout") panes) → $dest"
}

# Drop trailing blank lines in place. A pane that is 90% empty screen captures
# as 90% newlines, and those replay as a wall of blank scroll.
strip_trailing_blank() {
    local f="$1"
    [ -s "$f" ] || return 0
    local tmpf
    tmpf="$(mktemp "${TMPDIR:-/tmp}/ttyd-snap.XXXXXX")" || return 0
    # tac twice around a sed that eats leading blanks: portable "strip trailing
    # blank lines" without slurping the file into a variable.
    tac "$f" 2>/dev/null | sed -e '/./,$!d' | tac >"$tmpf" 2>/dev/null && mv "$tmpf" "$f"
    rm -f "$tmpf"
}

# ── restore ──────────────────────────────────────────────────

# Programs worth relaunching. Read from the live tmux server so
# deploy/config/tmux-persist.conf stays the single place this is declared;
# the literal is only the fallback for a server that has not loaded it.
restorable_list() {
    local opt
    opt="$(tmux show-option -gqv @resurrect-processes 2>/dev/null)"
    [ -n "$opt" ] || opt='"~claude" "~codex" ssh psql "~node" "~python3" htop'
    printf '%s' "$opt"
}

# resurrect's matching rules: a bare name must match the whole command, and a
# `~`-prefixed name matches a command that carries arguments.
is_restorable() {
    local cmd="$1" entry bare
    [ -n "$cmd" ] || return 1
    for entry in $(restorable_list); do
        entry="${entry%\"}"
        entry="${entry#\"}"
        [ -n "$entry" ] || continue
        if [ "${entry:0:1}" = "~" ]; then
            bare="${entry:1}"
            [ "$cmd" = "$bare" ] && return 0
        else
            [ "$cmd" = "$entry" ] && return 0
        fi
    done
    return 1
}

# An agent pane resumes into its transcript, which redraws the whole screen the
# moment it starts — replaying scrollback underneath it would be wiped before
# anyone saw it, and the transcript is the better record anyway. Every other
# pane gets its screen back.
is_agent_cmd() {
    case "$1" in
        claude | codex) return 0 ;;
    esac
    return 1
}

# The shell command a restored pane is launched with: optionally replay the
# saved screen, then either relaunch the saved program or drop to a shell.
pane_launch_cmd() {
    local snap="$1" win="$2" pane="$3" pane_cmd="$4" full_cmd="$5"
    local sb="$snap/panes/w${win}.p${pane}"
    local prefix="" tail_cmd

    if [ -s "$sb" ] && ! is_agent_cmd "$pane_cmd"; then
        prefix="cat $(printf '%q' "$sb"); "
    fi

    if [ -n "$full_cmd" ] && is_restorable "$pane_cmd"; then
        tail_cmd="$full_cmd; exec ${SHELL:-/bin/bash}"
    else
        tail_cmd="exec ${SHELL:-/bin/bash}"
    fi

    printf '%s%s' "$prefix" "$tail_cmd"
}

cmd_restore() {
    local name="${1:-}"
    [ -n "$name" ] || die "restore: session name required"
    name="$(sanitize "$name")"
    need_tmux

    local snap
    snap="$(snap_dir "$name")"
    [ -f "$snap/layout" ] || die "restore: no snapshot for '$name'"

    if tmux has-session -t "$(tgt "$name")" 2>/dev/null; then
        die "restore: session '$name' is already running"
    fi

    # Windows first, so panes always have a window to land in. Sorted
    # numerically because list-windows order is not guaranteed after a
    # move-window.
    local -a win_idx=() win_name=() win_layout=()
    local active_window=""
    local line
    while IFS= read -r line; do
        split_tabs "$line"
        [ "${#FIELDS[@]}" -ge 7 ] || continue
        win_idx+=("${FIELDS[2]}")
        win_name+=("${FIELDS[3]#:}")
        win_layout+=("${FIELDS[6]}")
        [ "${FIELDS[4]}" = "1" ] && active_window="${FIELDS[2]}"
    done < <(grep '^window' "$snap/layout" | sort -t"$TAB" -k3,3n)

    [ "${#win_idx[@]}" -gt 0 ] || die "restore: snapshot for '$name' has no windows"

    # First pane of the first window creates the session. Everything after it
    # is a new-window or a split-window.
    local created=0 i w
    for i in "${!win_idx[@]}"; do
        w="${win_idx[$i]}"
        local first_pane=1
        local p_win p_idx p_dir p_cmd p_full launch pline
        while IFS= read -r pline; do
            split_tabs "$pline"
            [ "${#FIELDS[@]}" -ge 11 ] || continue
            p_win="${FIELDS[2]}"
            [ "$p_win" = "$w" ] || continue
            p_idx="${FIELDS[5]}"
            p_dir="${FIELDS[7]}"
            p_cmd="${FIELDS[9]}"
            p_full="${FIELDS[10]}"
            p_dir="${p_dir#:}"
            p_dir="${p_dir//\\ / }"
            p_full="${p_full#:}"
            [ -d "$p_dir" ] || p_dir="$HOME"
            launch="$(pane_launch_cmd "$snap" "$w" "$p_idx" "$p_cmd" "$p_full")"

            if [ "$created" = 0 ]; then
                tmux new-session -d -s "$name" -n "${win_name[$i]}" -c "$p_dir" "$launch" || die "restore: new-session failed"
                created=1
                # new-session lands the window on base-index, which is not
                # necessarily the index it had when saved.
                local cur
                cur="$(tmux display-message -p -t "$(tgt "$name")" '#{window_index}' 2>/dev/null)"
                if [ -n "$cur" ] && [ "$cur" != "$w" ]; then
                    tmux move-window -s "$(tgt "$name"):$cur" -t "$(tgt "$name"):$w" 2>/dev/null || true
                fi
                first_pane=0
            elif [ "$first_pane" = 1 ]; then
                tmux new-window -d -t "$(tgt "$name"):$w" -n "${win_name[$i]}" -c "$p_dir" "$launch" 2>/dev/null ||
                    tmux new-window -d -t "$(tgt "$name")" -n "${win_name[$i]}" -c "$p_dir" "$launch" || true
                first_pane=0
            else
                tmux split-window -d -t "$(tgt "$name"):$w" -c "$p_dir" "$launch" 2>/dev/null || true
            fi
        done < <(grep '^pane' "$snap/layout" | sort -t"$TAB" -k6,6n)

        # select-layout replays the exact geometry, which is cheaper and more
        # faithful than trying to reproduce it with split direction flags.
        [ -n "${win_layout[$i]}" ] &&
            tmux select-layout -t "$(tgt "$name"):$w" "${win_layout[$i]}" 2>/dev/null || true
    done

    [ "$created" = 1 ] || die "restore: snapshot for '$name' produced no panes"

    [ -n "$active_window" ] && tmux select-window -t "$(tgt "$name"):$active_window" 2>/dev/null || true

    # The snapshot has served its purpose; leaving it would silently shadow the
    # live session the next time the reaper looks.
    rm -rf "$snap"
    return 0
}

# ── query / housekeeping ─────────────────────────────────────

cmd_has() {
    local name
    name="$(sanitize "${1:-}")"
    [ -n "$name" ] || return 1
    [ -f "$(snap_dir "$name")/layout" ]
}

# The working directory a restore would create the session in: the first pane
# of the lowest-numbered window, picked with the same sort order cmd_restore
# walks the layout in. ttyd-session.sh compares it with an explicit cwd: to
# decide whether the snapshot still matches the route asking for it.
cmd_dir() {
    local name snap first_win="" line dir
    name="$(sanitize "${1:-}")"
    [ -n "$name" ] || die "dir: session name required"
    snap="$(snap_dir "$name")"
    [ -f "$snap/layout" ] || die "dir: no snapshot for '$name'"

    while IFS= read -r line; do
        split_tabs "$line"
        [ "${#FIELDS[@]}" -ge 7 ] || continue
        first_win="${FIELDS[2]}"
        break
    done < <(grep '^window' "$snap/layout" | sort -t"$TAB" -k3,3n)
    [ -n "$first_win" ] || die "dir: snapshot for '$name' has no windows"

    while IFS= read -r line; do
        split_tabs "$line"
        [ "${#FIELDS[@]}" -ge 11 ] || continue
        [ "${FIELDS[2]}" = "$first_win" ] || continue
        dir="${FIELDS[7]#:}"
        printf '%s\n' "${dir//\\ / }"
        return 0
    done < <(grep '^pane' "$snap/layout" | sort -t"$TAB" -k6,6n)
    die "dir: snapshot for '$name' has no panes in window $first_win"
}

cmd_list() {
    [ -d "$SNAP_ROOT" ] || return 0
    local d name saved reason windows panes
    for d in "$SNAP_ROOT"/*/; do
        [ -f "$d/layout" ] || continue
        name="$(basename "$d")"
        saved=""; reason=""; windows=""; panes=""
        # shellcheck disable=SC1090
        while IFS='=' read -r k v; do
            case "$k" in
                saved_at_iso) saved="$v" ;;
                reason) reason="$v" ;;
                windows) windows="$v" ;;
                panes) panes="$v" ;;
            esac
        done <"$d/meta" 2>/dev/null
        printf '%-28s %s  %sw/%sp  %s\n' "$name" "${saved:-?}" "${windows:-?}" "${panes:-?}" "${reason:-?}"
    done
}

cmd_rm() {
    local name
    name="$(sanitize "${1:-}")"
    [ -n "$name" ] || die "rm: session name required"
    rm -rf "$(snap_dir "$name")"
    echo "removed snapshot $name"
}

cmd_prune() {
    local days="${1:-$KEEP_DAYS}"
    [ -d "$SNAP_ROOT" ] || return 0
    local d
    while IFS= read -r d; do
        [ -n "$d" ] || continue
        echo "pruned $(basename "$d")"
        rm -rf "$d"
    done < <(find "$SNAP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$days" 2>/dev/null)
}

# ── dispatch ─────────────────────────────────────────────────
case "${1:-}" in
    save) shift; cmd_save "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    has) shift; cmd_has "$@" ;;
    dir) shift; cmd_dir "$@" ;;
    list) shift; cmd_list "$@" ;;
    rm) shift; cmd_rm "$@" ;;
    prune) shift; cmd_prune "$@" ;;
    -h | --help | "") sed -n '/^# Usage:/,/^# ═\+$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//' ;;
    *) die "unknown command '$1' (try --help)" ;;
esac
