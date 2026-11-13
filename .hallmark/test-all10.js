(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const check = (name, cond) => { out[name] = !!cond; };
  const rows = (suf = "") => [...document.querySelectorAll(`#file-body${suf} tr`)];
  const rowByName = (n, suf = "") => rows(suf).find((r) => r.querySelector(".file-name")?.textContent === n);
  const key = (k, opts = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  const invokes = (cmd) => window.__invokes.filter((i) => i[0] === cmd);
  const ctxItem = (label) => [...document.querySelectorAll("#ctx-menu .ctx-item")].find((b) => b.textContent === label);

  await sleep(200);

  // Normalize inherited profile state (the harness WebKit profile persists
  // localStorage: a previous run may have left sort=size or icons view).
  const sortSel0 = document.getElementById("sort-key");
  sortSel0.value = "name";
  sortSel0.dispatchEvent(new Event("change", { bubbles: true }));
  if (document.getElementById("table-wrap").hidden) document.getElementById("view-details").click();
  // A previous run may have left dual pane on; this suite turns it on itself.
  const p1n = document.getElementById("pane-1");
  if (p1n && !p1n.hidden) {
    document.getElementById("act-dual").click();
    await sleep(120);
  }
  await sleep(120);

  // 1. Shift+arrow range selection (anchor model)
  rowByName("Docs").click();
  key("ArrowDown", { shiftKey: true });
  key("ArrowDown", { shiftKey: true });
  check("shift_arrow_3_selected", document.querySelectorAll("#file-body tr.is-selected").length === 3);
  key("ArrowDown", {});
  check("plain_arrow_single", document.querySelectorAll("#file-body tr.is-selected").length === 1);

  // 2. Ctrl+H hidden files
  const before = rows().length;
  key("h", { ctrlKey: true });
  check("ctrl_h_shows_hidden", rows().length === before + 1 && document.getElementById("show-hidden").checked === true);
  key("h", { ctrlKey: true });
  check("ctrl_h_hides_again", rows().length === before);

  // 3. True size sort (folder sizes cached: Docs 12345, Pics 678)
  const sortSel = document.getElementById("sort-key");
  sortSel.value = "size";
  sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(120);
  const order = rows().map((r) => r.querySelector(".file-name")?.textContent);
  check("size_sort_order", JSON.stringify(order) === JSON.stringify(["notes.txt", "Pics", "tree.zip", "img.png", "Docs"]));
  sortSel.value = "name";
  sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(80);

  // 4. Drag-out offers file URIs
  const dt = new DataTransfer();
  rowByName("Docs").dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
  check("dragout_uri_list", [...dt.types].includes("text/uri-list") && dt.getData("text/uri-list").includes("file:///home/zyan/Docs"));
  rowByName("Docs").dispatchEvent(new DragEvent("dragend", { bubbles: true }));

  // 5. Preview: image (dimensions) + text (line numbers)
  document.getElementById("preview-toggle").click();
  rowByName("img.png").click();
  await sleep(120);
  check("preview_img", !!document.querySelector(".preview-img"));
  check("preview_img_caption", (document.querySelector(".preview-caption")?.textContent || "").includes("1 × 1"));
  rowByName("notes.txt").click();
  await sleep(150);
  const pre = document.querySelector(".preview-text");
  check("preview_text_lines", !!pre && pre.textContent.startsWith("   1  line one"));
  document.getElementById("preview-close").click();

  // 6. Open With dialog (sweep: closes after picking an app)
  navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(80);
  const ow = ctxItem("Open With…");
  check("ctx_open_with_present", !!ow);
  ow.click();
  await sleep(120);
  check("open_with_dialog_apps", document.querySelectorAll("#open-with-list .ctx-item").length === 2);
  document.querySelector("#open-with-list .ctx-item").click();
  await sleep(80);
  check("open_with_closes", document.getElementById("dlg-open-with").open === false);
  check("open_with_invoked", invokes("open_with").some((i) => i[1].exec === "gedit %f"));

  // 7. Copy Path
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(80);
  ctxItem("Copy Path").click();
  await sleep(80);
  check("copy_path", window.__copied === "/home/zyan/notes.txt");

  // 8. Batch rename (sweep: closes after confirm)
  rowByName("notes.txt").click();
  rowByName("img.png").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(80);
  ctxItem("Batch rename…").click();
  await sleep(80);
  check("batch_dialog_open", document.getElementById("dlg-batch").open === true);
  const find = document.getElementById("batch-find");
  find.value = "notes"; find.dispatchEvent(new Event("input", { bubbles: true }));
  const rep = document.getElementById("batch-replace");
  rep.value = "memo"; rep.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
  check("batch_preview", document.getElementById("batch-preview").textContent.includes("memo.txt"));
  document.getElementById("batch-confirm").click();
  await sleep(120);
  check("batch_closes", document.getElementById("dlg-batch").open === false);
  check("batch_renamed", invokes("rename_path").some((i) => i[1].new_name === "memo.txt"));

  // 9. Content search
  document.getElementById("search-content").click();
  const search = document.getElementById("search");
  search.value = "hello";
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(200);
  check("content_results", rows().length === 2 && rows().every((r) => (r.querySelector(".file-sub")?.textContent || "").startsWith("line ")));
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(200);

  // 10. Duplicates
  document.getElementById("act-dupes").click();
  await sleep(200);
  check("dupe_head", !!document.querySelector("#file-body tr.dupe-head"));
  check("dupe_selected_rest", document.querySelectorAll("#file-body tr.is-selected").length === 1);
  check("dupe_delete_label", document.getElementById("dupe-delete").textContent.includes("(1)"));
  document.getElementById("dupe-delete").click();
  await sleep(120);
  check("dupe_delete_invoked", invokes("delete_paths").length >= 1);
  document.getElementById("dupe-done").click();
  await sleep(200);
  check("dupe_exited", document.getElementById("dupe-bar").hidden === true);

  // 11. Dual pane
  document.getElementById("act-dual").click();
  await sleep(250);
  check("dual_pane_visible", !!document.getElementById("pane-1") && document.getElementById("pane-1").hidden === false);
  check("dual_two_tables", rows("-1").length >= 1);
  document.getElementById("file-area-1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  check("dual_activate_pane1", document.getElementById("pane-1").classList.contains("is-active"));
  document.getElementById("file-area").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  check("dual_activate_pane0", document.getElementById("pane-0").classList.contains("is-active"));
  // F5 copies the selection to the OTHER pane's current folder. The harness
  // profile may persist several tabs per pane (the closed-tab suite leaves
  // two), so read the destination from pane 1's own head instead of
  // assuming Home.
  const dest1 = document.getElementById("pane-head-1")?.textContent;
  rowByName("Docs").click();
  key("F5", {});
  await sleep(120);
  check("dual_f5_copy", invokes("start_transfer").some((i) => i[1].dest === dest1 && i[1].copy === true));
  // Scroll regression: the cloned pane-1 file area must be a real scroll
  // container (it once lost its #file-area id styles in the clone, so it
  // grew to full content height and never scrolled). Force a short height
  // so the listing overflows, then a scrollTop must stick, in both panes.
  document.querySelector(".crumb").click();
  await sleep(150);
  const fa0 = document.getElementById("file-area");
  const fa1 = document.getElementById("file-area-1");
  check("dual_scroll_style", getComputedStyle(fa1).overflowY === "auto" && getComputedStyle(fa0).overflowY === "auto");
  fa0.style.height = "120px";
  fa1.style.height = "120px";
  await sleep(50);
  check("dual_scroll_overflow", fa0.scrollHeight > fa0.clientHeight && fa1.scrollHeight > fa1.clientHeight);
  fa0.scrollTop = 60;
  fa1.scrollTop = 60;
  check("dual_scroll_sticks", fa0.scrollTop === 60 && fa1.scrollTop === 60);
  fa0.style.height = "";
  fa1.style.height = "";
  key("d", { ctrlKey: true, shiftKey: true });
  await sleep(120);
  check("dual_toggle_off", document.getElementById("pane-1").hidden === true);

  window.__dndResult = JSON.stringify(out);
})();
