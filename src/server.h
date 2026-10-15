#include <libwebsockets.h>
#include <stdbool.h>
#include <uv.h>

#include "file_upload.h"
#include "pty.h"

// client message
#define INPUT '0'
#define RESIZE_TERMINAL '1'
#define PAUSE '2'
#define RESUME '3'
#define JSON_DATA '{'

// server message
#define OUTPUT '0'
#define SET_WINDOW_TITLE '1'
#define SET_PREFERENCES '2'

// url paths
struct endpoints {
  char *ws;
  char *index;
  char *token;
  char *parent;
  char *image;
  char *tabs;
  char *login;
};

extern volatile bool force_exit;
extern struct lws_context *context;
extern struct server *server;
extern struct endpoints endpoints;

// What a POST body being accumulated is destined for. NONE means the request
// has no body we care about, so anything it sends is dropped on the floor.
enum post_kind { POST_NONE, POST_FILE, POST_TABS };

struct pss_http {
  char path[128];
  char *buffer;
  char *ptr;
  size_t len;

  // POST body accumulator, shared by /image-upload and /tabs. File writes run
  // on libuv's worker pool, hence the stored wsi used to wake the response.
  struct lws *wsi;
  enum post_kind post;
  char *body;
  size_t body_len;
  size_t body_max;
  bool body_too_large;
  // Filename the browser sent for this upload, already percent-decoded but not
  // yet sanitised — file_upload_store() owns that.
  char upload_name[256];
  file_upload_req *upload;
  // A queued JSON answer ({"path": "…"} / {"error": "…"}), written out on
  // the next writable callback.
  bool json_reply;
  int json_status;
  char json_error[128];
  char json_path[FILE_UPLOAD_PATH_MAX];
  // Session token this response has to hand back in a Set-Cookie, empty when
  // there is nothing to send: the request either arrived with a cookie that is
  // still good for a while, or it is not authenticated at all.
  char cookie[65];
};

struct pss_tty {
  bool initialized;
  int initial_cmd_index;
  bool authenticated;
  char user[30];
  char address[50];
  char path[128];
  char **args;
  int argc;

  struct lws *wsi;
  char *buffer;
  size_t len;

  pty_process *process;
  pty_buf_t *pty_buf;

  int lws_close_status;
};

typedef struct {
  struct pss_tty *pss;
  bool ws_closed;
} pty_ctx_t;

struct server {
  int client_count;        // client count
  char *prefs_json;        // client preferences
  char *credential;        // encoded basic auth credential
  char *auth_header;       // header name used for auth proxy
  char *index;             // custom index.html
  char *tabs_file;         // where the UI's tab layout is stored (NULL = /tabs disabled)
  char *session_file;      // where issued login sessions are kept (NULL = memory only)
  int auth_max_age;        // how long a login cookie stays valid, in seconds (0 = no cookie)
  bool cookie_partitioned; // secure login cookie is SameSite=None + Partitioned, for cross-site iframes
  char *command;           // full command line
  char **argv;             // command with arguments
  int argc;                // command + arguments count
  char *cwd;               // working directory
  int sig_code;            // close signal
  char sig_name[20];       // human readable signal string
  bool url_arg;            // allow client to send cli arguments in URL
  bool writable;           // whether clients to write to the TTY
  bool check_origin;       // whether allow websocket connection from different origin
  int max_clients;         // maximum clients to support
  bool once;               // whether accept only one client and exit on disconnection
  bool exit_no_conn;       // whether exit on all clients disconnection
  char socket_path[255];   // UNIX domain socket path
  char terminal_type[30];  // terminal type to report

  uv_loop_t *loop;         // the libuv event loop
};
