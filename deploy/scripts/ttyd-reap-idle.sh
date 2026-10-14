#!/bin/bash
# ══════════════════════════════════════════════════════════════
# ttyd-reap-idle — snapshot and close tmux sessions nobody is using
# ══════════════════════════════════════════════════════════════
#
# Every browser tab that ever opened `?arg=name:<x>` leaves a tmux session
# behind, and nothing ever closes them: a session costs a shell, whatever agent
# CLI was started in it, and its scrollback, for as long as the box is up. On a
# 2-core VM a dozen forgotten `claude` processes is real memory and real CPU
# contention with the sessions still in use.
#
# So: anything idle past the threshold is snapshotted (ttyd-snapshot.sh) and
# killed. The snapshot is what makes this safe to run unattended — the next
# browser request for that name rebuilds the session from it, agent panes
# included, instead of handing back an empty shell. Reaping without the
# snapshot step would just be data loss on a timer.
#
# Idleness is `session_activity`, which tmux bumps whenever a pane produces
# output. A session running a long job is never idle no matter how long it
# runs; a session parked at a shell prompt is idle from the last command.
#
# Attached sessions are skipped. `session_attached > 0` means a browser tab is
# open on it right now, and activity does NOT advance just because someone is
# watching — reaping those would close sessions out from under a live viewer.
#
# Only sessions ttyd-pro created are ever touched. ttyd-session.sh registers
# every session it attaches to under $STATE/owned/<name>, and a session with
# no entry there is left alone no matter how idle it is — the gateway's
# `claude setup-token` window and anything started by hand at an SSH prompt are
# not ours to close. `--all` overrides that for a one-off sweep.
#
# Usage:
#   ttyd-reap-idle.sh [--dry-run] [--idle <spec>] [--keep a,b] [--prune-days N]
#
#   --dry-run          report what would be reaped, touch nothing
#   --idle <spec>      idle threshold: 3d, 12h, 90m, or plain seconds
#                      (default: $TTYD_REAP_IDLE, else 12h)
#   --keep a,b         never reap these session names (adds to $TTYD_REAP_KEEP)
#   --all              consider every tmux session, not just ttyd-pro's
#   --prune-days N     also drop snapshots older than N days (default 30)
#   --quiet            log to the file only, nothing on stdout
#
# A single session can carry its own threshold, set from the URL that opened it
# (`?arg=idle:1h`) or by hand:
#   tmux set-option -t <session> @ttyd-idle 1h
#
# A session can also opt out of reaping entirely — `?arg=noreap`, or:
#   tmux set-option -t <session> @ttyd-no-reap 1
#
# Environment:
#   TTYD_REAP_IDLE     default threshold spec
#   TTYD_REAP_KEEP     comma-separated names to never reap
#   TTYD_STATE_DIR     state root (log + snapshots live under it)
# ══════════════════════════════════════════════════════════════

set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT="$SELF_DIR/ttyd-snapshot.sh"

STATE_DIR="${TTYD_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ttyd}"
LOG_FILE="$STATE_DIR/reap.log"

DRY_RUN=0
QUIET=0
REAP_ALL=0
IDLE_SPEC="${TTYD_REAP_IDLE:-12h}"
KEEP_RAW="${TTYD_REAP_KEEP:-}"
PRUNE_DAYS="${TTYD_SNAPSHOT_KEEP_DAYS:-30}"

TAB=$'\t'

die() {
    echo "ttyd-reap-idle: $*" >&2
    exit 1
}

# Both to the log and (unless --quiet) to stdout, so the same line shows up in
# `journalctl --user -u ttyd-reap-idle` and in the file for anyone reading
# history after the journal has rotated.
log() {
    local line
    line="$(date -Is) $*"
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null
    [ "$QUIET" = 1 ] || printf '%s\n' "$line"
}

# 3d / 12h / 90m / 45s / bare seconds → seconds.
parse_duration() {
    local spec="$1" num unit
    num="${spec%[dhms]}"
    unit="${spec#"$num"}"
    case "$num" in
        '' | *[!0-9]*) return 1 ;;
    esac
    case "$unit" in
        d) printf '%s' $((num * 86400)) ;;
        h) printf '%s' $((num * 3600)) ;;
        m) printf '%s' $((num * 60)) ;;
        s | '') printf '%s' "$num" ;;
        *) return 1 ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --quiet) QUIET=1; shift ;;
        --all) REAP_ALL=1; shift ;;
        --idle) IDLE_SPEC="${2:-}"; shift 2 ;;
        --idle=*) IDLE_SPEC="${1#*=}"; shift ;;
        --keep) KEEP_RAW="$KEEP_RAW,${2:-}"; shift 2 ;;
        --keep=*) KEEP_RAW="$KEEP_RAW,${1#*=}"; shift ;;
        --prune-days) PRUNE_DAYS="${2:-}"; shift 2 ;;
        --prune-days=*) PRUNE_DAYS="${1#*=}"; shift ;;
        -h | --help)
            sed -n '/^# Usage:/,/^# ═\+$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
            exit 0
            ;;
        *) die "unknown option '$1' (try --help)" ;;
    esac
done

IDLE_SECONDS="$(parse_duration "$IDLE_SPEC")" || die "bad --idle value '$IDLE_SPEC'"
[ "$IDLE_SECONDS" -gt 0 ] 2>/dev/null || die "--idle must be greater than zero"

command -v tmux >/dev/null 2>&1 || exit 0
# No server, nothing to reap. This is the normal state on a freshly booted box
# and must not look like a failure in the timer's exit status.
tmux has-session 2>/dev/null || exit 0

mkdir -p "$STATE_DIR" 2>/dev/null

# The session this script is itself running inside, if any. Reaping it would
# kill the reaper mid-run and leave the snapshot half-written.
SELF_SESSION=""
if [ -n "${TMUX:-}" ]; then
    SELF_SESSION="$(tmux display-message -p '#{session_name}' 2>/dev/null)"
fi

OWNED_DIR="$STATE_DIR/owned"

# Per-session settings from the registry, into REG_*. Absent file → not ours.
REG_OWNED=0
REG_IDLE=""
REG_NOREAP=0
read_registry() {
    local name="$1" k v
    REG_OWNED=0
    REG_IDLE=""
    REG_NOREAP=0
    [ -f "$OWNED_DIR/$name" ] || return 0
    REG_OWNED=1
    while IFS='=' read -r k v; do
        case "$k" in
            idle) REG_IDLE="$v" ;;
            noreap) [ "$v" = "1" ] && REG_NOREAP=1 ;;
        esac
    done <"$OWNED_DIR/$name"
    return 0
}

is_kept() {
    local name="$1" entry
    [ -n "$name" ] || return 1
    [ "$name" = "$SELF_SESSION" ] && return 0
    local IFS=','
    for entry in $KEEP_RAW; do
        entry="${entry# }"
        entry="${entry% }"
        [ -n "$entry" ] || continue
        [ "$name" = "$entry" ] && return 0
    done
    return 1
}

NOW="$(date +%s)"
reaped=0
kept=0
failed=0
skipped_foreign=0
session_idle=0
session_spec=""
parsed=""
candidate=""

# Read every session up front. Killing sessions while iterating over a live
# `tmux list-sessions` pipe would have the shell reading from a command whose
# output describes a world it is concurrently changing.
# The three @-options are prefixed with ':' because they are usually UNSET, and
# `read` with IFS=$'\t' treats tab as IFS *whitespace*: it collapses a run of
# tabs into one delimiter and every field after an empty one shifts left. The
# colon keeps each field non-empty and is stripped below — the same trick
# tmux-resurrect uses on its own optional columns.
sessions="$(tmux list-sessions -F "#{session_name}${TAB}#{session_attached}${TAB}#{session_activity}${TAB}#{session_windows}${TAB}:#{@ttyd-no-reap}${TAB}:#{@ttyd-pro}${TAB}:#{@ttyd-idle}" 2>/dev/null)"

while IFS="$TAB" read -r name attached activity windows no_reap is_ours own_idle; do
    [ -n "$name" ] || continue
    no_reap="${no_reap#:}"
    is_ours="${is_ours#:}"
    own_idle="${own_idle#:}"

    read_registry "$name"

    # Ours if the registry says so, or if this tmux server still carries the
    # marker. Either is proof enough; requiring both would drop sessions whose
    # registry entry was cleaned up, or that a resurrect restore rebuilt
    # without their options.
    if [ "$REAP_ALL" = 0 ] && [ "$REG_OWNED" = 0 ] && [ "$is_ours" != "1" ]; then
        skipped_foreign=$((skipped_foreign + 1))
        continue
    fi

    # Self-heal a session the registry owns but tmux has forgotten — the case
    # after a reboot, where resurrect rebuilt it without its options.
    if [ "$REG_OWNED" = 1 ] && [ "$is_ours" != "1" ] && [ "$DRY_RUN" = 0 ]; then
        # Trailing colon: `set-option -t =name` reports "no such session"
        # where `has-session -t =name` succeeds. See mark_owned() in
        # ttyd-session.sh.
        tmux set-option -t "=$name:" @ttyd-pro 1 2>/dev/null
    fi

    if [ "${attached:-0}" != "0" ]; then
        kept=$((kept + 1))
        continue
    fi
    if { [ -n "${no_reap:-}" ] && [ "$no_reap" != "0" ]; } || [ "$REG_NOREAP" = 1 ]; then
        log "keep    $name (opted out)"
        kept=$((kept + 1))
        continue
    fi
    if is_kept "$name"; then
        kept=$((kept + 1))
        continue
    fi

    # A per-session threshold beats the global one. The tmux option wins over
    # the registry: it is what a URL just set, the registry is what it was.
    session_idle="$IDLE_SECONDS"
    session_spec="$IDLE_SPEC"
    for candidate in "$own_idle" "$REG_IDLE"; do
        [ -n "$candidate" ] || continue
        if parsed="$(parse_duration "$candidate")" && [ "$parsed" -gt 0 ] 2>/dev/null; then
            session_idle="$parsed"
            session_spec="$candidate"
            break
        fi
        log "warn    $name has an unparseable idle value '$candidate', using $IDLE_SPEC"
    done

    # A session with no activity timestamp is one tmux could not describe;
    # leave it alone rather than guess it is idle.
    case "${activity:-}" in
        '' | *[!0-9]*) kept=$((kept + 1)); continue ;;
    esac

    idle=$((NOW - activity))
    if [ "$idle" -lt "$session_idle" ]; then
        kept=$((kept + 1))
        continue
    fi

    idle_h=$((idle / 3600))
    if [ "$DRY_RUN" = 1 ]; then
        log "would reap $name (idle ${idle_h}h >= ${session_spec}, ${windows} windows)"
        reaped=$((reaped + 1))
        continue
    fi

    # Snapshot first, kill second, and only ever in that order: a kill whose
    # snapshot failed is the data loss this whole script exists to avoid.
    if ! "$SNAPSHOT" save "$name" "idle-${idle_h}h" >/dev/null 2>&1; then
        log "SKIP    $name — snapshot failed, session left running"
        failed=$((failed + 1))
        continue
    fi
    if tmux kill-session -t "=$name" 2>/dev/null; then
        log "reaped  $name (idle ${idle_h}h, ${windows} windows, snapshot saved)"
        reaped=$((reaped + 1))
    else
        log "SKIP    $name — kill-session failed after snapshot"
        failed=$((failed + 1))
    fi
done <<<"$sessions"

if [ "$DRY_RUN" = 0 ] && [ -n "$PRUNE_DAYS" ]; then
    "$SNAPSHOT" prune "$PRUNE_DAYS" 2>/dev/null | while IFS= read -r pruned; do
        [ -n "$pruned" ] && log "$pruned"
    done
fi

log "done: ${reaped} reaped, ${kept} kept, ${skipped_foreign} not ours, ${failed} failed (threshold ${IDLE_SPEC})"
[ "$failed" = 0 ]
