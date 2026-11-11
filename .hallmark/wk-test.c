/* Minimal WebKitGTK probe: does __setTheme / inline custom properties
   actually restyle the page in this webkit2gtk build? */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <JavaScriptCore/JavaScript.h>

static void js_cb(GObject *obj, GAsyncResult *res, gpointer data) {
  GError *err = NULL;
  JSCValue *v = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(obj), res, &err);
  if (!v) { g_print("JS ERR: %s\n", err ? err->message : "?"); gtk_main_quit(); return; }
  char *s = jsc_value_to_string(v);
  g_print("JS: %s\n", s ? s : "(null)");
  g_free(s);
  g_object_unref(v);
  gtk_main_quit();
}

static const char *g_mode = "read";

static void on_load(WebKitWebView *wv, WebKitLoadEvent ev, gpointer data) {
  if (ev != WEBKIT_LOAD_FINISHED) return;
  if (!g_strcmp0(g_mode, "hold")) return; /* keep window open for screenshots */
  char *js = g_strdup_printf(
    "(function(){"
    " var out={};"
    " out.mode='%s';"
    " if (out.mode==='seed'){ localStorage.setItem('filemon-theme','light'); out.seeded=localStorage.getItem('filemon-theme'); return JSON.stringify(out); }"
    " out.dataset=document.documentElement.dataset.theme;"
    " out.inline=document.documentElement.style.getPropertyValue('--color-paper');"
    " out.bg=getComputedStyle(document.body).backgroundColor;"
    " out.attr=(document.documentElement.getAttribute('style')||'').slice(0,120);"
    " return JSON.stringify(out);"
    "})()", g_mode);
  webkit_web_view_evaluate_javascript(wv, js, -1, NULL, NULL, NULL, js_cb, NULL);
  g_free(js);
}

int main(int argc, char **argv) {
  if (argc > 2) g_mode = argv[2];
  gtk_init(&argc, &argv);
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(win), 800, 600);
  WebKitWebView *wv = WEBKIT_WEB_VIEW(webkit_web_view_new());
  gtk_container_add(GTK_CONTAINER(win), GTK_WIDGET(wv));
  g_signal_connect(wv, "load-changed", G_CALLBACK(on_load), NULL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  webkit_web_view_load_uri(wv, argv[1]);
  gtk_widget_show_all(win);
  /* Safety: quit after 15s even if the JS never returns. */
  g_timeout_add_seconds(15, (GSourceFunc)gtk_main_quit, NULL);
  gtk_main();
  return 0;
}
