// Next-10 round: address bar, advanced filters, reopen closed tab,
// archive preview, Markdown preview, Properties chmod + SHA-256,
// Always open with, disk thumbnail cache, compare folders.
// Runs against the shimmed dist in wk-test (4 s budget).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const check = (name, cond) => { out[name] = !!cond; window.__dndResult = JSON.stringify(out); };
  const rows = (suf = "") => [...document.querySelectorAll(`#file-body${suf} tr`)].filter((r) => !r.classList.contains("dupe-head") && !r.classList.contains("group-head"));
  const rowByName = (n, suf = "") => rows(suf).find((r) => r.querySelector(".file-name")?.textContent === n);
  const key = (k, opts = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  const invokes = (cmd) => window.__invokes.filter((i) => i[0] === cmd);
  const ctxItem = (label) => [...document.querySelectorAll("#ctx-menu .ctx-item")].find((b) => b.textContent === label);
  const setInput = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };

  await sleep(80);

  // Normalize inherited profile state. A previous run may have left dual
  // pane on with pane 1 active; the filter/address checks below read
  // pane 0, so switch dual off and activate pane 0 first.
  const p1 = document.getElementById("pane-1");
  if (p1 && !p1.hidden) {
    key("d", { ctrlKey: true, shiftKey: true });
    await sleep(80);
  }
  document.getElementById("pane-0").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const sortSel = document.getElementById("sort-key");
  sortSel.value = "name"; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  if (document.getElementById("table-wrap").hidden) document.getElementById("view-details").click();
  // Close extra tabs left by previous runs (tabs persist in localStorage).
  while (document.querySelectorAll("#tab-bar .tab").length > 1) {
    document.querySelector("#tab-bar .tab .tab-close").click();
    await sleep(50);
  }
  await sleep(80);

  // ---- 3. Address bar (Ctrl+L) ----
  // The address bar shows the current path, whatever the persisted tab is.
  key("l", { ctrlKey: true });
  const ab = document.getElementById("address-bar");
  check("address_bar_open", !ab.hidden && ab.value === document.getElementById("side-path").textContent && document.getElementById("crumbs").hidden);
  ab.value = "/home/zyan/Docs";
  ab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(80);
  check("address_bar_navigate", ab.hidden && document.getElementById("side-path").textContent === "/home/zyan/Docs");
  key("l", { ctrlKey: true });
  ab.value = "/home/zyan";
  ab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await sleep(80);
  check("address_bar_back", document.getElementById("side-path").textContent === "/home/zyan");
  key("l", { ctrlKey: true });
  ab.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  check("address_bar_escape", ab.hidden && !document.getElementById("crumbs").hidden);

  // ---- 4. Advanced filters (default list: 5 visible rows) ----
  // Wait for the folder-size events (100 ms after the last loadDir) so the
  // size filters see the folders' computed sizes.
  await sleep(150);
  document.getElementById("act-filter").click();
  check("filter_panel_open", !document.getElementById("filter-panel").hidden);
  setInput("filter-kind", "images");
  document.getElementById("filter-kind").dispatchEvent(new Event("change", { bubbles: true }));
  check("filter_kind_images", rows().length === 1 && rowByName("img.png"));
  setInput("filter-kind", "all");
  document.getElementById("filter-kind").dispatchEvent(new Event("change", { bubbles: true }));
  setInput("filter-ext", "txt");
  check("filter_ext_txt", rows().length === 1 && rowByName("notes.txt"));
  setInput("filter-ext", "");
  setInput("filter-min", "5");
  // Folders count by their computed size: Docs is 12345 (shim folder-size
  // event, fired long before this point), so min 5 KB keeps Docs + img.png.
  check("filter_size_min", rows().length === 2 && rowByName("Docs") && rowByName("img.png"));
  setInput("filter-min", "");
  setInput("filter-max", "1");
  // Max 1 KB keeps notes.txt (120 B), tree.zip (900 B) and Pics (678).
  check("filter_size_max", rows().length === 3 && rowByName("notes.txt") && rowByName("tree.zip") && rowByName("Pics"));
  document.getElementById("filter-clear").click();
  check("filter_clear", rows().length === 5 && !document.getElementById("act-filter").classList.contains("is-active"));

  // ---- 7. Reopen closed tab (Ctrl+Shift+T) ----
  const tabCount = () => document.querySelectorAll("#tab-bar .tab").length;
  check("closed_tab_start", tabCount() === 1);
  key("t", { ctrlKey: true });
  await sleep(80);
  check("closed_tab_new", tabCount() === 2);
  key("w", { ctrlKey: true });
  await sleep(80);
  check("closed_tab_closed", tabCount() === 1);
  key("t", { ctrlKey: true, shiftKey: true });
  await sleep(80);
  check("closed_tab_reopen", tabCount() === 2);

  // Extended listing for the preview / compare checks.
  window.__extendedList = true;
  document.querySelector(".crumb").click();
  await sleep(80);

  // ---- 8. Markdown preview ----
  document.getElementById("preview-toggle").click();
  rowByName("guide.md").click();
  await sleep(80);
  const md = document.querySelector("#preview-body .md-preview");
  check("markdown_preview", !!md && md.querySelector("h1")?.textContent === "Guide" && md.querySelector("strong")?.textContent === "bold" && !!md.querySelector("code") && md.querySelectorAll("ul li").length === 2);

  // ---- 5. Archive preview ----
  rowByName("tree.zip").click();
  await sleep(80);
  const arch = document.querySelectorAll("#preview-body .archive-row");
  check("archive_preview", arch.length === 3 && arch[0].querySelector(".archive-name")?.textContent === "a.txt" && arch[1].querySelector(".archive-size")?.textContent === "—");

  // ---- 6. Properties: SHA-256 + chmod ----
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(40);
  ctxItem("Properties").click();
  await sleep(80);
  const dlg = document.getElementById("dlg-props");
  check("props_dialog", dlg.open && document.getElementById("props-mode")?.value === "644" && document.querySelector(".props-sha")?.textContent === "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const modeInput = document.getElementById("props-mode");
  modeInput.value = "600";
  document.querySelectorAll("#dlg-props .props-perm .btn")[0].click();
  await sleep(40);
  check("props_chmod", invokes("set_permissions").some((i) => i[1].mode === 384) && modeInput.value === "640");
  document.querySelector("#dlg-props .btn-primary").click();
  await sleep(40);

  // ---- 9. Always open with ----
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(40);
  ctxItem("Open With…").click();
  await sleep(80);
  const always = document.getElementById("open-with-always");
  check("always_checkbox", !!always && !always.checked);
  always.checked = true;
  document.querySelector("#open-with-list .ctx-item").click();
  await sleep(80);
  check("always_open_with", invokes("set_default_app").some((i) => i[1].desktop === "org.gnome.TextEditor.desktop") && invokes("open_with").some((i) => i[1].exec === "gedit %f"));

  // ---- 1. Compare folders (dual pane) ----
  key("d", { ctrlKey: true, shiftKey: true });
  await sleep(80);
  check("compare_dual_on", !document.getElementById("pane-1").hidden);
  rowByName("notes.txt").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 120 }));
  await sleep(40);
  ctxItem("Compare with other pane").click();
  await sleep(80);
  const heads = [...document.querySelectorAll("#file-body tr.dupe-head")].map((h) => h.textContent);
  check("compare_rows", !document.getElementById("compare-bar").hidden && heads.length === 3 && heads[0].includes("Only in this pane") && document.getElementById("status-count").textContent.includes("1 only here"));
  document.getElementById("compare-copy-out").click();
  await sleep(850);
  check("compare_copy_out", invokes("start_transfer").some((i) => (i[1].paths || []).includes("/home/zyan/notes.txt")) && !document.getElementById("compare-bar").hidden);
  document.getElementById("compare-done").click();
  await sleep(80);
  check("compare_done", document.getElementById("compare-bar").hidden && rows().length === 14);

  // ---- 7b. Active pane persists across restarts ----
  document.getElementById("pane-1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  check("active_pane_persist", localStorage.getItem("filemon-active-pane") === "1");

  // ---- 10b. Dual-pane thumbnails: both panes' tiles get observed.
  // (Regression: renderGridFor used to disconnect() the shared observer,
  // dropping pane 0's tiles so their thumbnails never loaded.)
  document.getElementById("view-icons").click(); // pane 1 -> icons
  await sleep(80);
  document.getElementById("pane-0").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.getElementById("view-icons").click(); // pane 0 -> icons
  await sleep(80);
  const dt0 = [...document.querySelectorAll("#grid-wrap .tile")].find((t) => t.querySelector(".tile-name")?.textContent === "img.png");
  const dt1 = [...document.querySelectorAll("#grid-wrap-1 .tile")].find((t) => t.querySelector(".tile-name")?.textContent === "img.png");
  dt0.scrollIntoView();
  dt1.scrollIntoView();
  await sleep(200);
  check("dual_thumb_both_panes", dt0?.dataset.thumb === "done" && dt1?.dataset.thumb === "done");

  window.__dndResult = JSON.stringify(out);
})();
