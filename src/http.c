#include <json.h>
#include <libwebsockets.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zlib.h>

#include "compat.h"
#include "html.h"
#include "server.h"
#include "utils.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

// Cap on an accepted paste or drop. Screenshots and documents are far below
// this; the limit exists because the body is buffered whole in memory and the
// handler sits on the same port as the terminal.
#define MAX_UPLOAD_BYTES (32 * 1024 * 1024)

// Cap on a stored tab layout. A few hundred tabs still fit comfortably; the
// point is that an unauthenticated-looking POST can't grow a file forever.
#define MAX_TABS_BYTES (1024 * 1024)

// Name of the cookie a successful basic-auth hands back, and the size of the
// random token inside it. 32 bytes is far past guessing range, and the hex
// form keeps the cookie printable.
#define AUTH_COOKIE "ttyd_session"
#define SESSION_TOKEN_BYTES 32
#define SESSION_TOKEN_HEX (SESSION_TOKEN_BYTES * 2)

// How many logins stay valid at once. One per browser that has ever signed in
// and not expired — a phone, a laptop, a few private windows. Past this the
// oldest is dropped rather than growing the file without bound.
#define MAX_SESSIONS 32

static char *html_cache = NULL;
static size_t html_cache_len = 0;

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

// Validator for the embedded bundle, computed once and then reused. The bundle
// is baked into the binary, so this value only changes when ttyd itself does —
// which is exactly when a browser has to stop reusing what it cached. Encoding
// is part of it: the gzip stream and the inflated HTML are different bytes and
// must not share a cache entry.
static const char *index_etag(bool gzip) {
  static char gz[24], raw[24];
  if (gz[0] == '\0') {
    unsigned long long h = 1469598103934665603ULL;
    for (size_t i = 0; i < index_html_len; i++) {
      h ^= index_html[i];
      h *= 1099511628211ULL;
    }
    snprintf(gz, sizeof(gz), "\"%016llx-gz\"", h);
    snprintf(raw, sizeof(raw), "\"%016llx\"", h);
  }
  return gzip ? gz : raw;
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;

    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);

    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in = (void *)index_html;
    stream.next_out = (void *)html_cache;

    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }

  *output = html_cache;
  *output_len = html_cache_len;

  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer != (char *)index_html && pss->buffer != html_cache) free(pss->buffer);
}

// Queue the JSON answer to a POST. json-c performs the actual escaping in the
// writable callback; these fields only retain the values until then.
static void json_result(struct pss_http *pss, int status, const char *path, const char *error) {
  snprintf(pss->json_path, sizeof(pss->json_path), "%s", path != NULL ? path : "");
  snprintf(pss->json_error, sizeof(pss->json_error), "%s", error != NULL ? error : "");
  pss->json_status = status;
  pss->json_reply = true;
  lws_callback_on_writable(pss->wsi);
}

static void file_upload_done(void *ctx, int status, const char *path, const char *error) {
  struct pss_http *pss = (struct pss_http *)ctx;

  pss->upload = NULL;
  json_result(pss, status == 0 ? HTTP_STATUS_OK : HTTP_STATUS_INTERNAL_SERVER_ERROR, path, error);
}

static void request_reset(struct pss_http *pss) {
  if (pss->upload != NULL) {
    file_upload_detach(pss->upload);
    pss->upload = NULL;
  }
  free(pss->body);
  pss->body = NULL;
  pss->body_len = 0;
  pss->body_max = 0;
  pss->body_too_large = false;
  pss->post = POST_NONE;
  pss->upload_name[0] = '\0';
  pss->json_reply = false;
  pss->json_path[0] = '\0';
  pss->json_error[0] = '\0';
  pss->cookie[0] = '\0';
}

// Whole-file read, used to answer GET /tabs and to load the session list.
// Returns a NUL-terminated buffer the caller owns, or NULL when the file is
// missing or unreadable — which is not an error: a deployment that has never
// saved a layout, or never had anyone log in, simply has no file yet.
static char *read_file(const char *path, size_t *out_len) {
  FILE *fp = fopen(path, "rb");
  if (fp == NULL) return NULL;

  if (fseek(fp, 0, SEEK_END) != 0) {
    fclose(fp);
    return NULL;
  }
  long size = ftell(fp);
  if (size < 0 || size > MAX_TABS_BYTES || fseek(fp, 0, SEEK_SET) != 0) {
    fclose(fp);
    return NULL;
  }

  char *buf = xmalloc((size_t)size + 1);
  size_t n = fread(buf, 1, (size_t)size, fp);
  fclose(fp);
  buf[n] = '\0';
  *out_len = n;
  return buf;
}

// Replace `path` with `data`. Written to a sibling temp file and renamed, so a
// reader (or a crash) never sees a half-written layout — losing the tab list
// to a torn write would be worse than not saving it at all. Returns a libuv
// status code on failure, 0 on success.
static int write_file_atomic(const char *path, const char *data, size_t len) {
  char *tmp_template = xmalloc(strlen(path) + 8);
  sprintf(tmp_template, "%s.XXXXXX", path);

  uv_fs_t open_req;
  int fd = uv_fs_mkstemp(NULL, &open_req, tmp_template, NULL);
  if (fd < 0) {
    uv_fs_req_cleanup(&open_req);
    free(tmp_template);
    return fd;
  }
  char *tmp = xmalloc(strlen(open_req.path) + 1);
  strcpy(tmp, open_req.path);
  uv_fs_req_cleanup(&open_req);
  free(tmp_template);

  int status = 0;
  size_t off = 0;
  while (off < len) {
    uv_buf_t buf = uv_buf_init((char *)data + off, (unsigned int)(len - off));
    uv_fs_t write_req;
    int written = uv_fs_write(NULL, &write_req, fd, &buf, 1, -1, NULL);
    uv_fs_req_cleanup(&write_req);
    if (written < 0) {
      status = written;
      break;
    }
    if (written == 0) {
      status = UV_EIO;
      break;
    }
    off += (size_t)written;
  }

  if (status == 0) {
    uv_fs_t sync_req;
    status = uv_fs_fsync(NULL, &sync_req, fd, NULL);
    uv_fs_req_cleanup(&sync_req);
  }

  uv_fs_t close_req;
  int close_status = uv_fs_close(NULL, &close_req, fd, NULL);
  uv_fs_req_cleanup(&close_req);
  if (status == 0 && close_status < 0) status = close_status;

  if (status == 0) {
    // 0600: the layout names every session the user has open.
    uv_fs_t chmod_req;
    status = uv_fs_chmod(NULL, &chmod_req, tmp, 0600, NULL);
    uv_fs_req_cleanup(&chmod_req);
  }
  if (status == 0) {
    uv_fs_t rename_req;
    status = uv_fs_rename(NULL, &rename_req, tmp, path, NULL);
    uv_fs_req_cleanup(&rename_req);
  }
  if (status != 0) {
    uv_fs_t unlink_req;
    uv_fs_unlink(NULL, &unlink_req, tmp, NULL);
    uv_fs_req_cleanup(&unlink_req);
  }

  free(tmp);
  return status;
}

// ── login sessions ─────────────────────────────────────────────────────────
//
// Basic auth alone means a password prompt every time the browser forgets the
// credential, which it does often: a restart, a fresh PWA window, a phone that
// dropped the tab. So the first successful basic-auth also hands out a cookie
// holding a random token, and any later request carrying that token is let
// through without the header. The tokens live here, not in the cookie, so
// deleting the file logs every browser out.

struct auth_session {
  char token[SESSION_TOKEN_HEX + 1];
  long long expiry;  // unix seconds
};

static struct auth_session sessions[MAX_SESSIONS];
static int session_count = 0;
static bool sessions_loaded = false;

enum { SESSION_UNKNOWN, SESSION_OK, SESSION_RENEWED };

// FNV-1a over the encoded credential. Written into the session file so that a
// changed password invalidates every token issued under the old one — the
// stored list is only meaningful for the credential that created it.
static unsigned long long cred_fingerprint(void) {
  unsigned long long h = 1469598103934665603ULL;
  for (const char *s = server->credential != NULL ? server->credential : ""; *s != '\0'; s++) {
    h ^= (unsigned char)*s;
    h *= 1099511628211ULL;
  }
  return h;
}

static bool is_hex_token(const char *s) {
  for (size_t i = 0; i < SESSION_TOKEN_HEX; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return s[SESSION_TOKEN_HEX] == '\0';
}

static void sessions_load(void) {
  if (sessions_loaded) return;
  sessions_loaded = true;  // a missing or unreadable file just means no sessions yet
  if (server->session_file == NULL) return;

  size_t len = 0;
  char *data = read_file(server->session_file, &len);
  if (data == NULL) return;

  char *save = NULL;
  char *line = strtok_r(data, "\n", &save);
  unsigned long long stored = 0;
  if (line == NULL || sscanf(line, "ttyd-session 1 %llu", &stored) != 1 || stored != cred_fingerprint()) {
    free(data);
    return;
  }

  long long now = (long long)time(NULL);
  while ((line = strtok_r(NULL, "\n", &save)) != NULL && session_count < MAX_SESSIONS) {
    char token[SESSION_TOKEN_HEX + 1];
    long long expiry;
    if (sscanf(line, "%64s %lld", token, &expiry) != 2) continue;
    if (!is_hex_token(token) || expiry <= now) continue;
    memcpy(sessions[session_count].token, token, sizeof(token));
    sessions[session_count].expiry = expiry;
    session_count++;
  }

  free(data);
}

static void sessions_save(void) {
  if (server->session_file == NULL) return;

  size_t cap = 64 + (size_t)session_count * (SESSION_TOKEN_HEX + 24);
  char *buf = xmalloc(cap);
  size_t n = (size_t)snprintf(buf, cap, "ttyd-session 1 %llu\n", cred_fingerprint());
  for (int i = 0; i < session_count; i++)
    n += (size_t)snprintf(buf + n, cap - n, "%s %lld\n", sessions[i].token, sessions[i].expiry);

  int err = write_file_atomic(server->session_file, buf, n);
  // Not fatal: the sessions still work for as long as this process runs, they
  // just won't survive a restart.
  if (err != 0) lwsl_warn("session: cannot write %s: %s\n", server->session_file, uv_strerror(err));
  free(buf);
}

static bool sessions_prune(long long now) {
  int kept = 0;
  for (int i = 0; i < session_count; i++)
    if (sessions[i].expiry > now) sessions[kept++] = sessions[i];

  bool dropped = kept != session_count;
  session_count = kept;
  return dropped;
}

// Fixed-length compare that always walks the whole token, so how long the
// answer takes says nothing about how much of a guess was right.
static bool token_equal(const char *a, const char *b) {
  unsigned char diff = 0;
  for (size_t i = 0; i < SESSION_TOKEN_HEX; i++) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

// Look a cookie token up. Past the halfway mark the deadline is pushed back
// (and the caller re-sends the cookie), so a browser in regular use never sees
// the password prompt again while one that stops coming back still expires on
// schedule.
static int session_accept(const char *token) {
  sessions_load();

  long long now = (long long)time(NULL);
  bool dirty = sessions_prune(now);
  int result = SESSION_UNKNOWN;

  for (int i = 0; i < session_count; i++) {
    if (!token_equal(sessions[i].token, token)) continue;
    result = SESSION_OK;
    if (sessions[i].expiry - now < server->auth_max_age / 2) {
      sessions[i].expiry = now + server->auth_max_age;
      result = SESSION_RENEWED;
      dirty = true;
    }
    break;
  }

  if (dirty) sessions_save();
  return result;
}

// Mint a token for a browser that just proved it knows the password. Writes
// SESSION_TOKEN_HEX + 1 bytes into `out`; leaves it empty if the platform
// could not give us enough randomness, in which case the login still works,
// it just doesn't get a cookie.
static void session_issue(char *out) {
  unsigned char raw[SESSION_TOKEN_BYTES];
  if (lws_get_random(context, raw, sizeof(raw)) != sizeof(raw)) {
    lwsl_warn("session: no randomness available, issuing no cookie\n");
    out[0] = '\0';
    return;
  }

  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(raw); i++) {
    out[i * 2] = hex[raw[i] >> 4];
    out[i * 2 + 1] = hex[raw[i] & 0xf];
  }
  out[SESSION_TOKEN_HEX] = '\0';

  sessions_load();
  long long now = (long long)time(NULL);
  sessions_prune(now);

  if (session_count == MAX_SESSIONS) {
    int oldest = 0;
    for (int i = 1; i < session_count; i++)
      if (sessions[i].expiry < sessions[oldest].expiry) oldest = i;
    memmove(&sessions[oldest], &sessions[oldest + 1], (size_t)(session_count - oldest - 1) * sizeof(sessions[0]));
    session_count--;
  }

  memcpy(sessions[session_count].token, out, SESSION_TOKEN_HEX + 1);
  sessions[session_count].expiry = now + server->auth_max_age;
  session_count++;
  sessions_save();
}

// Pull our token out of the Cookie header, into a buffer of at least
// SESSION_TOKEN_HEX + 1 bytes. Anything the wrong length is not a token we
// ever issued, so it is treated as absent.
static bool cookie_token(struct lws *wsi, char *out) {
  char buf[1024];
  if (lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_COOKIE) <= 0) return false;

  for (char *p = buf; p != NULL && *p != '\0';) {
    while (*p == ' ' || *p == ';') p++;
    char *sep = strchr(p, ';');
    if (sep != NULL) *sep = '\0';

    if (!strncmp(p, AUTH_COOKIE "=", sizeof(AUTH_COOKIE))) {
      char *value = p + sizeof(AUTH_COOKIE);
      if (strlen(value) != SESSION_TOKEN_HEX) return false;
      memcpy(out, value, SESSION_TOKEN_HEX + 1);
      return true;
    }
    p = sep != NULL ? sep + 1 : NULL;
  }

  return false;
}

// Attach the Set-Cookie for a session just issued or renewed. Path is the base
// path, so a ttyd mounted under a prefix does not hand its cookie to the rest
// of the site. Secure only when the request actually arrived over TLS: the
// usual deployment is plain HTTP behind a tunnel, and a browser drops a Secure
// cookie that came over http — which would mean the password prompt forever.
static int add_session_cookie(struct lws *wsi, struct pss_http *pss, unsigned char **p, unsigned char *end) {
  if (pss->cookie[0] == '\0') return 0;

  char proto[16];
  bool secure = lws_is_ssl(wsi) || (lws_hdr_custom_copy(wsi, proto, sizeof(proto), "x-forwarded-proto:", 18) > 0 &&
                                    !strcmp(proto, "https"));

  char value[256];
  int n = snprintf(value, sizeof(value), "%s=%s; Path=%s; Max-Age=%d; HttpOnly; SameSite=Lax%s", AUTH_COOKIE,
                   pss->cookie, endpoints.parent[0] ? endpoints.parent : "/", server->auth_max_age,
                   secure ? "; Secure" : "");

  return lws_add_http_header_by_name(wsi, (unsigned char *)"set-cookie:", (unsigned char *)value, n, p, end);
}

static int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// ── one-time login links ───────────────────────────────────────────────────
//
// A link that logs one browser in without a password prompt, so a front-end
// that has already authenticated the user does not make them prove it twice.
//
//   POST /login                 Mints a one-time token. Behind the ordinary
//                               auth check, so the caller has just proven it
//                               holds the password (or a live session).
//
//   GET  /login?t=<token>[&r=]  Spends it, and hands back the same login cookie
//                               basic auth issues — nothing downstream needs to
//                               know a link was involved.
//
// The token is not a bearer credential for the terminal: it buys exactly one
// login, once, within a couple of minutes. Basic auth stays underneath, so the
// terminal is still reachable when whatever issues these links is down.
//
// What it buys is a *full* login, though, not a scoped one: a logged-in page
// reads the credential back from /token to replay on reconnect, so the browser
// that redeems a link ends up holding the password. The one-time part protects
// the link in transit, not the browser at the end of it.

// How many unspent links may be outstanding, and how long each one lives. The
// window only has to cover a redirect the front-end triggers immediately; the
// table only has to cover the logins in flight at one moment.
#define MAX_LOGIN_LINKS 16
#define LOGIN_LINK_MAX_AGE 120

// Kept apart from `sessions`: these are not logins yet, they only buy one. A
// process restart drops them, which costs nothing — the front-end mints another
// on the next click, unlike a session, which is why sessions have a file and
// these do not.
static struct {
  char token[SESSION_TOKEN_HEX + 1];
  long long expiry;
} login_links[MAX_LOGIN_LINKS];
static int login_link_count = 0;

static void login_links_prune(long long now) {
  int kept = 0;
  for (int i = 0; i < login_link_count; i++)
    if (login_links[i].expiry > now) login_links[kept++] = login_links[i];
  login_link_count = kept;
}

// Mint a token for a caller that has already authenticated. Writes
// SESSION_TOKEN_HEX + 1 bytes into `out`, or leaves it empty when the platform
// has no randomness to give — an unguessable token is the entire mechanism, so
// there is no degraded mode worth offering.
static void login_link_issue(char *out) {
  unsigned char raw[SESSION_TOKEN_BYTES];
  if (lws_get_random(context, raw, sizeof(raw)) != sizeof(raw)) {
    lwsl_warn("login: no randomness available, issuing no link\n");
    out[0] = '\0';
    return;
  }

  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(raw); i++) {
    out[i * 2] = hex[raw[i] >> 4];
    out[i * 2 + 1] = hex[raw[i] & 0xf];
  }
  out[SESSION_TOKEN_HEX] = '\0';

  long long now = (long long)time(NULL);
  login_links_prune(now);
  // Full means links are being minted faster than they are spent. Dropping the
  // oldest keeps the newest — the one someone is most likely still waiting on.
  if (login_link_count == MAX_LOGIN_LINKS) {
    memmove(&login_links[0], &login_links[1], (size_t)(MAX_LOGIN_LINKS - 1) * sizeof(login_links[0]));
    login_link_count--;
  }
  memcpy(login_links[login_link_count].token, out, SESSION_TOKEN_HEX + 1);
  login_links[login_link_count].expiry = now + LOGIN_LINK_MAX_AGE;
  login_link_count++;
}

// Spend a token. Removing it before returning is what makes it one-time, so a
// link replayed from a browser history or a proxy log buys nothing.
static bool login_link_claim(const char *token) {
  long long now = (long long)time(NULL);
  login_links_prune(now);

  for (int i = 0; i < login_link_count; i++) {
    if (!token_equal(login_links[i].token, token)) continue;
    memmove(&login_links[i], &login_links[i + 1], (size_t)(login_link_count - i - 1) * sizeof(login_links[0]));
    login_link_count--;
    return true;
  }
  return false;
}

static bool is_lower_hex(const char *s, size_t len) {
  for (size_t i = 0; i < len; i++)
    if (hex_value(s[i]) < 0 || (s[i] >= 'A' && s[i] <= 'F')) return false;
  return true;
}

// Copy one `name=` fragment out of the query string. Returns false when the
// query carries no such name, or its value does not fit.
static bool url_arg(struct lws *wsi, const char *name, char *out, size_t out_len) {
  char frag[512];
  size_t name_len = strlen(name);
  for (int i = 0; lws_hdr_copy_fragment(wsi, frag, sizeof(frag), WSI_TOKEN_HTTP_URI_ARGS, i) > 0; i++) {
    if (strncmp(frag, name, name_len) != 0 || frag[name_len] != '=') continue;
    const char *value = frag + name_len + 1;
    if (strlen(value) >= out_len) return false;
    snprintf(out, out_len, "%s", value);
    return true;
  }
  return false;
}

// Login links only mean anything when a session cookie is what gets a request
// past the gate. --auth-header hands that decision to a proxy, which never
// looks at our cookie, and --auth-max-age 0 turns cookies off outright: in both
// cases a redeemed link would mint a credential nothing downstream accepts, and
// the browser would land straight back on the login it was meant to skip.
static bool login_links_enabled(void) { return server->auth_header == NULL && server->auth_max_age > 0; }

// Whether this request is a GET. Spending a one-time token is a side effect, so
// it must not happen on a method that is supposed to have none: link previews
// in chat apps and mail scanners fire HEAD at every URL they are shown, and a
// HEAD that redeemed the link would leave the person who clicks it a 403.
static bool is_get(struct lws *wsi) {
  if (lws_hdr_total_length(wsi, WSI_TOKEN_GET_URI) > 0) return true;
#if defined(LWS_ROLE_H2)
  char method[8];
  if (lws_hdr_copy(wsi, method, sizeof(method), WSI_TOKEN_HTTP_COLON_METHOD) > 0) return strcmp(method, "GET") == 0;
#endif
  return false;
}

// Read `?t=` and spend it. On success the browser held a link this server
// minted in the last couple of minutes, and had not used it before.
static bool login_link_from_url(struct lws *wsi) {
  char token[SESSION_TOKEN_HEX + 1];
  if (!url_arg(wsi, "t", token, sizeof(token))) return false;
  // Length and alphabet first: token_equal reads a fixed SESSION_TOKEN_HEX
  // bytes, so a short value would walk off the end of this buffer.
  if (strlen(token) != SESSION_TOKEN_HEX || !is_lower_hex(token, SESSION_TOKEN_HEX)) return false;
  return login_link_claim(token);
}

// Where to land after a successful login. `?r=` lets the issuer aim at a
// specific terminal (`/?arg=cwd:/srv/app`), but only ever within this server:
// anything not a plain absolute path — a scheme, a `//host` shorthand, a
// backslash some parsers read as a slash — makes this an open redirect for
// whoever can read a link, so those fall back to the index.
static const char *login_redirect_target(struct lws *wsi, char *out, size_t out_len) {
  if (!url_arg(wsi, "r", out, out_len)) return endpoints.index;
  if (out[0] != '/' || out[1] == '/' || out[1] == '\\') return endpoints.index;
  for (const char *c = out; *c != '\0'; c++)
    if ((unsigned char)*c < 0x20 || *c == '\\') return endpoints.index;
  return out;
}

static int send_unauthorized(struct lws *wsi, unsigned int code, enum lws_token_indexes header) {
  unsigned char buffer[1024 + LWS_PRE], *p, *end;
  p = buffer + LWS_PRE;
  end = p + sizeof(buffer) - LWS_PRE;

  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header, (unsigned char *)"Basic realm=\"ttyd\"", 18, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;

  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi, struct pss_http *pss) {
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header, strlen(server->auth_header)) > 0) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }

  if(server->credential != NULL) {
    // A cookie from an earlier login stands in for the credential. An unknown
    // one is not an error — it may be from before a password change — it just
    // falls through to the header check below.
    char token[SESSION_TOKEN_HEX + 1];
    if (server->auth_max_age > 0 && cookie_token(wsi, token)) {
      switch (session_accept(token)) {
        case SESSION_RENEWED:
          memcpy(pss->cookie, token, sizeof(token));
          return AUTH_OK;
        case SESSION_OK:
          return AUTH_OK;
        default:
          break;
      }
    }

    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ")) {
      if (!strcmp(buf + 6, server->credential)) {
        if (server->auth_max_age > 0) session_issue(pss->cookie);
        return AUTH_OK;
      }
    }
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED, WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }

  return AUTH_OK;
}

// Store the body of a POST /tabs. The blob is opaque to the server — only the
// UI knows what a tab is — but it has to be valid JSON, so a malformed request
// can't leave the file unparseable for every future reader.
static void tabs_store(struct pss_http *pss) {
  struct json_object *parsed = json_tokener_parse(pss->body);
  if (parsed == NULL) {
    json_result(pss, HTTP_STATUS_BAD_REQUEST, NULL, "not valid json");
    return;
  }
  json_object_put(parsed);

  int err = write_file_atomic(server->tabs_file, pss->body, pss->body_len);
  if (err != 0) {
    lwsl_err("tabs: cannot write %s: %s\n", server->tabs_file, uv_strerror(err));
    json_result(pss, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, uv_strerror(err));
    return;
  }
  json_result(pss, HTTP_STATUS_OK, NULL, NULL);
}


// Pick up the filename the browser attached to an upload. An HTTP header may
// only carry ASCII while a filename may be anything, so the UI sends it
// percent-encoded (encodeURIComponent). Decoding it here just gets the bytes
// back; what is actually safe to put on disk is decided by the sanitiser in
// file_upload.c, so a hostile name is harmless either way.
static void read_upload_name(struct lws *wsi, struct pss_http *pss) {
  char raw[512];
  int len = lws_hdr_custom_copy(wsi, raw, sizeof(raw), "x-ttyd-filename:", 16);
  if (len <= 0) return;

  size_t out = 0;
  for (int i = 0; i < len && out + 1 < sizeof(pss->upload_name); i++) {
    char c = raw[i];
    if (c == '%' && i + 2 < len) {
      int hi = hex_value(raw[i + 1]), lo = hex_value(raw[i + 2]);
      if (hi >= 0 && lo >= 0) {
        c = (char)((hi << 4) | lo);
        i += 2;
      }
    }
    // A NUL would truncate the name for every later reader; drop it and let
    // the sanitiser see the rest.
    if (c == '\0') continue;
    pss->upload_name[out++] = c;
  }
  pss->upload_name[out] = '\0';
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[50];

  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

int callback_http(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[256];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP:
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);
      pss->wsi = wsi;
      request_reset(pss);  // the connection may be reused across requests

      // Ahead of check_auth on purpose: arriving without a credential is the
      // entire point of a login link. Only the GET half skips auth; POST mints
      // tokens and is handled below, behind check_auth.
      if (login_links_enabled() && strcmp(pss->path, endpoints.login) == 0 && is_get(wsi)) {
        if (!login_link_from_url(wsi)) {
          // No detail in the body: whether the token expired, was already
          // spent, or never existed is exactly what a guesser would like told.
          lwsl_warn("login: rejected link\n");
          lws_return_http_status(wsi, HTTP_STATUS_FORBIDDEN, NULL);
          goto try_to_reuse;
        }

        char target[256];
        const char *location = login_redirect_target(wsi, target, sizeof(target));
        session_issue(pss->cookie);

        p = buffer + LWS_PRE;
        end = p + sizeof(buffer) - LWS_PRE;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (unsigned char *)location,
                                         (int)strlen(location), &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      switch (check_auth(wsi, pss)) {
        case AUTH_OK:
          break;
        case AUTH_FAIL:
          return 0;
        case AUTH_ERROR:
        default:
          return 1;
      }

      p = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      if (strcmp(pss->path, endpoints.token) == 0) {
        const char *credential = server->credential != NULL ? server->credential : "";
        size_t n = snprintf(buf, sizeof(buf), "{\"token\": \"%s\"}", credential);
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(buf);
        pss->len = n;
        lws_callback_on_writable(wsi);
        break;
      }

      // Mint a one-time login link. The caller has just proven it holds the
      // password (or a live session), so handing it a token gives away nothing
      // it could not already do — while letting it hand a browser a login
      // without putting the password itself in a URL.
      if (strcmp(pss->path, endpoints.login) == 0) {
        if (!login_links_enabled()) {
          // Nothing a token could redeem into. Reported as absent rather than
          // failed: under --auth-header or --auth-max-age 0 this endpoint
          // genuinely is not part of the server.
          lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
          goto try_to_reuse;
        }

        char link[SESSION_TOKEN_HEX + 1];
        login_link_issue(link);
        if (link[0] == '\0') {
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }

        // Its own buffer, not the shared `buf`: two 64-char tokens plus a
        // base-path-prefixed endpoint overrun 256 well before anything says so.
        char json[512];
        int written = snprintf(json, sizeof(json), "{\"token\": \"%s\", \"url\": \"%s?t=%s\", \"expires_in\": %d}",
                               link, endpoints.login, link, LOGIN_LINK_MAX_AGE);
        if (written <= 0 || (size_t)written >= sizeof(json)) {
          lws_return_http_status(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL);
          goto try_to_reuse;
        }
        size_t n = (size_t)written;

        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            // No shared cache should ever hold one of these.
            lws_add_http_header_by_name(wsi, (unsigned char *)"cache-control:", (unsigned char *)"no-store", 8, &p,
                                        end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(json);
        pss->len = n;
        lws_callback_on_writable(wsi);
        break;
      }

      // File paste/drop bridge. The browser stores a pasted or dropped file on
      // the ttyd host. The UI then pastes the returned path into the
      // foreground agent using its documented local-file syntax; no host
      // clipboard is involved. The path is still `/image-upload` because
      // browser tabs loaded before this became general still post to it.
      if (strcmp(pss->path, endpoints.image) == 0) {
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) == 0) {
          lws_return_http_status(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL);
          goto try_to_reuse;
        }
        // Answer from LWS_CALLBACK_HTTP_BODY_COMPLETION once the worker has
        // durably stored the file.
        read_upload_name(wsi, pss);
        pss->post = POST_FILE;
        pss->body_max = MAX_UPLOAD_BYTES;
        return 0;
      }

      // Tab layout. localStorage keeps the tab list per browser, so the same
      // deployment opened from a phone and a laptop shows two unrelated sets
      // of tabs and a cleared cache loses them. This is where the UI parks the
      // list instead: a single opaque JSON blob, GET to read, POST to replace.
      // Off unless the deployment named a file to keep it in.
      if (strcmp(pss->path, endpoints.tabs) == 0) {
        if (server->tabs_file == NULL) {
          lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
          goto try_to_reuse;
        }
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) > 0) {
          // Answered from LWS_CALLBACK_HTTP_BODY_COMPLETION.
          pss->post = POST_TABS;
          pss->body_max = MAX_TABS_BYTES;
          return 0;
        }

        size_t saved_len = 0;
        char *saved = read_file(server->tabs_file, &saved_len);
        if (saved == NULL) {
          // Nothing saved yet — an empty object, so the client can treat "no
          // layout on the server" the same as "a layout with nothing in it".
          saved = strdup("{}");
          saved_len = 2;
        }
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CACHE_CONTROL, (unsigned char *)"no-store", 8, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)saved_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0) {
          free(saved);
          return 1;
        }

        pss->buffer = pss->ptr = saved;
        pss->len = saved_len;
        lws_callback_on_writable(wsi);
        break;
      }

      // redirects `/base-path` to `/base-path/`
      if (strcmp(pss->path, endpoints.parent) == 0) {
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (unsigned char *)endpoints.index,
                                         (int)strlen(endpoints.index), &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
        goto try_to_reuse;
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        // No Set-Cookie here: lws owns the whole header block for a served
        // file. A custom index still gets one, from the /token request the UI
        // makes as soon as it loads.
        int n = lws_serve_http_file(wsi, server->index, content_type, NULL, 0);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi))) return 1;
      } else {
        // Serve the embedded bundle pre-gzipped whenever the client takes it:
        // index_html is already the gzip stream (237 KB vs 875 KB inflated), so
        // this is the whole page-load cost for a UI that is one inline blob.
        //
        // lws's own stream compression is NOT a substitute, even when the lib is
        // built with it: it only engages for responses whose length it controls,
        // and the explicit Content-Length below pins the body — so deferring to
        // it shipped the inflated 875 KB on every load. Do the encoding here and
        // the ifdef disappears with it.
        bool gzip = accept_gzip(wsi);
        const char *etag = index_etag(gzip);

        // Every new browser tab, every reload and every reconnect asks for this
        // page again, and the answer is the same bytes until ttyd is upgraded.
        // A validator turns all of those into a 304 with no body — the 237 KB
        // is paid once per version instead of once per load. no-cache (rather
        // than a max-age) keeps the round trip, so an upgraded server is picked
        // up on the very next load instead of whenever a timer happens to run
        // out.
        char inm[64];
        int inm_len = lws_hdr_copy(wsi, inm, sizeof(inm), WSI_TOKEN_HTTP_IF_NONE_MATCH);
        if (inm_len > 0 && strcmp(inm, etag) == 0) {
          if (lws_add_http_header_status(wsi, HTTP_STATUS_NOT_MODIFIED, &p, end) ||
              lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_ETAG, (unsigned char *)etag, (int)strlen(etag), &p,
                                           end) ||
              lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CACHE_CONTROL, (unsigned char *)"no-cache", 8, &p,
                                           end) ||
              lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_VARY, (unsigned char *)"accept-encoding", 15, &p, end) ||
              add_session_cookie(wsi, pss, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
              lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
            return 1;
          goto try_to_reuse;
        }

        char *output = (char *)index_html;
        size_t output_len = index_html_len;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)content_type, 9, &p,
                                         end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_ETAG, (unsigned char *)etag, (int)strlen(etag), &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CACHE_CONTROL, (unsigned char *)"no-cache", 8, &p, end) ||
            // Two different bodies live at this one URL. Without this a shared
            // cache in front of ttyd can hand the gzip stream to a client that
            // never asked for it, which renders as a page of binary.
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_VARY, (unsigned char *)"accept-encoding", 15, &p, end) ||
            add_session_cookie(wsi, pss, &p, end))
          return 1;
        if (gzip) {
          if (lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING, (unsigned char *)"gzip", 4, &p, end))
            return 1;
        } else {
          if (!uncompress_html(&output, &output_len)) return 1;
        }

        if (lws_add_http_header_content_length(wsi, (unsigned long)output_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = output;
        pss->len = output_len;
        lws_callback_on_writable(wsi);
      }
      break;

    case LWS_CALLBACK_HTTP_BODY:
      // lws signals a bodyless POST with a zero-length chunk and a NULL `in`.
      if (pss->post == POST_NONE || pss->body_too_large || len == 0) break;

      // Overshooting the cap discards what was buffered: the body is useless
      // now, and holding it would let a single request pin the memory until
      // the client finishes uploading.
      if (pss->body_len + len > pss->body_max) {
        pss->body_too_large = true;
        free(pss->body);
        pss->body = NULL;
        pss->body_len = 0;
        break;
      }

      // One extra byte, always kept NUL: the tabs handler parses the body as a
      // C string and a JSON parser must not run off the end of it.
      pss->body = xrealloc(pss->body, pss->body_len + len + 1);
      memcpy(pss->body + pss->body_len, in, len);
      pss->body_len += len;
      pss->body[pss->body_len] = '\0';
      break;

    case LWS_CALLBACK_HTTP_BODY_COMPLETION:
      if (pss->post == POST_NONE) goto try_to_reuse;

      if (pss->body_too_large) {
        json_result(pss, HTTP_STATUS_REQ_ENTITY_TOO_LARGE, NULL, "body too large");
      } else if (pss->body_len == 0) {
        json_result(pss, HTTP_STATUS_BAD_REQUEST, NULL, "empty body");
      } else if (pss->post == POST_TABS) {
        tabs_store(pss);
      } else {
        // The bytes are not inspected: anything the user can paste or drop is
        // something they could already have written from the shell on the
        // other side of this same authenticated connection.
        int err = 0;
        char *data = pss->body;
        size_t data_len = pss->body_len;
        pss->body = NULL;  // ownership passes to the upload worker
        pss->body_len = 0;

        pss->upload = file_upload_store(server->loop, data, data_len, pss->upload_name, file_upload_done, pss, &err);
        if (pss->upload == NULL) json_result(pss, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, uv_strerror(err));
      }
      return 0;

    case LWS_CALLBACK_CLOSED_HTTP:
      // lws 4.5 reports the close of a connection that never completed a
      // request — a bare connect, a half-sent header — to protocols[0] with no
      // per-session data, so there is nothing to reset. Dereferencing it
      // anyway took the whole server down every time a proxy dropped an idle
      // spare connection.
      if (pss == NULL) break;
      request_reset(pss);
      break;

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (pss->json_reply) {
        pss->json_reply = false;
        pss->post = POST_NONE;

        json_object *reply = json_object_new_object();
        if (pss->json_status == HTTP_STATUS_OK && pss->json_path[0] != '\0')
          json_object_object_add(reply, "path", json_object_new_string(pss->json_path));
        else if (pss->json_status == HTTP_STATUS_OK)
          json_object_object_add(reply, "ok", json_object_new_boolean(true));
        else
          json_object_object_add(reply, "error", json_object_new_string(pss->json_error));
        const char *json = json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN);
        size_t n = strlen(json);

        p = buffer + LWS_PRE;
        end = p + sizeof(buffer) - LWS_PRE;
        if (lws_add_http_header_status(wsi, (unsigned int)pss->json_status, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(json);
        pss->len = n;
        json_object_put(reply);
        // fall through to write the body out below
      }

      if (!pss->buffer || pss->len == 0) {
        goto try_to_reuse;
      }

      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);

      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }

      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;
#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n", msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }

  return 0;

  /* if we're on HTTP1.1 or 2.0, will keep the idle connection alive */
try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;

  return 0;
}
