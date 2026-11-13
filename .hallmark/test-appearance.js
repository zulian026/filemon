// Appearance round: icons per type, grid zoom, group by, drive bars,
// Quick Look, code/PDF preview, video thumbnails, density, UI scale,
// empty state. Runs against the shimmed dist in wk-test (4 s budget).
(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok) => { out[name] = !!ok; window.__dndResult = JSON.stringify(out); };
  const rows = () => [...document.querySelectorAll("#file-body tr")].filter((r) => !r.classList.contains("dupe-head") && !r.classList.contains("group-head"));
  const rowByName = (n) => rows().find((r) => r.querySelector(".file-name")?.textContent === n);
  const key = (k, target = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  // Normalize: the WebKit profile persists localStorage (sort/view from
  // earlier runs), so start from a known state.
  const sortSel = document.getElementById("sort-key");
  sortSel.value = "name"; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  if (document.getElementById("table-wrap").hidden) document.getElementById("view-details").click();
  await sleep(120);

  // Extended listing: one file of each type.
  window.__extendedList = true;
  document.querySelector(".crumb").click(); // "This PC" -> reloads the listing
  await sleep(150);

  // 1. Distinct icons per file type.
  const icons = {};
  for (const r of rows()) icons[r.querySelector(".file-name").textContent] = r.querySelector(".file-icon").innerHTML;
  const distinct = new Set(Object.values(icons)).size;
  check("icons_distinct_types", distinct >= 8 && icons["code.rs"] !== icons["doc.pdf"] && icons["sheet.xlsx"] !== icons["slides.pptx"] && icons["video.mp4"] !== icons["song.mp3"] && icons["app.AppImage"] !== icons["tree.zip"] && icons["shortcut"] !== icons["notes.txt"]);

  // 4. Drive usage bars.
  const bars = [...document.querySelectorAll("#drive-list .drive-bar")];
  check("drive_bars", bars.length === 2);
  const used2 = bars[1]?.querySelector("span");
  check("drive_bar_90_full", used2 && used2.style.width === "90%" && used2.classList.contains("is-full"));
  const used1 = bars[0]?.querySelector("span");
  check("drive_bar_60", used1 && used1.style.width === "60%" && !used1.classList.contains("is-full"));

  // 3. Group by type in the table.
  document.getElementById("act-appearance").click();
  await sleep(50);
  const gsel = document.getElementById("appearance-group");
  gsel.value = "type"; gsel.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(80);
  const heads = [...document.querySelectorAll("#file-body tr.group-head .group-toggle")].map((b) => b.textContent);
  check("group_heads", heads.length === 12 && heads[0].includes("Folders") && heads[1].includes("Images"));
  // Collapse the first group (Folders: Docs + Pics).
  const before = rows().length;
  document.querySelector("#file-body tr.group-head .group-toggle").click();
  await sleep(50);
  check("group_collapse", rows().length === before - 2 && document.querySelector("#file-body tr.group-head .group-toggle").getAttribute("aria-expanded") === "false");
  // Back to none.
  gsel.value = "none"; gsel.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(80);

  // 6. Code preview with syntax highlighting + PDF embed.
  rowByName("code.rs").click();
  document.getElementById("preview-toggle").click();
  await sleep(150);
  check("preview_code_highlight", !!document.querySelector("#preview-body .preview-text .tok-kw") && !!document.querySelector("#preview-body .preview-text .tok-str") && !!document.querySelector("#preview-body .preview-text .tok-com"));
  rowByName("doc.pdf").click();
  await sleep(120);
  check("preview_pdf_embed", !!document.querySelector("#preview-body embed.preview-pdf"));

  // 5. Quick Look: Space opens, arrows step, Esc closes.
  rowByName("img.png").click();
  await sleep(50);
  key(" ");
  await sleep(120);
  check("quicklook_open_img", !document.getElementById("quicklook").hidden && !!document.querySelector("#quicklook-body .quicklook-img"));
  key("ArrowRight");
  await sleep(120);
  check("quicklook_next", document.getElementById("quicklook-title").textContent !== "img.png");
  key("Escape");
  await sleep(50);
  check("quicklook_closed", document.getElementById("quicklook").hidden);

  // 8. Density compact.
  document.getElementById("act-appearance").click();
  await sleep(50);
  document.querySelector('#appearance-panel [data-density="compact"]').click();
  check("density_compact", document.body.classList.contains("density-compact") && localStorage.getItem("filemon-density") === "compact");
  document.querySelector('#appearance-panel [data-density="comfortable"]').click();

  // 9. UI scale 110%.
  document.querySelector('#appearance-panel [data-scale="1.1"]').click();
  check("ui_scale_110", document.getElementById("app").style.zoom === "1.1");
  document.querySelector('#appearance-panel [data-scale="1"]').click();

  // 2. Grid zoom via Ctrl+wheel.
  document.getElementById("view-icons").click();
  await sleep(80);
  const tile = document.querySelector("#grid-wrap .tile");
  tile.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(50);
  check("grid_zoom_wheel", document.getElementById("grid-wrap").classList.contains("zoom-2"));
  // 7. Video thumbnail via the cached `thumb` command (the shim returns a
  // 1x1 PNG); the image tile uses the same path.
  const vtile = [...document.querySelectorAll("#grid-wrap .tile")].find((t) => t.querySelector(".tile-name")?.textContent === "video.mp4");
  check("video_thumb_attempt", vtile && vtile.dataset.thumb !== undefined);
  vtile.scrollIntoView();
  await sleep(250);
  check("video_thumb_done", vtile && vtile.dataset.thumb === "done" && !!vtile.querySelector("img.tile-thumb"));
  const itile = [...document.querySelectorAll("#grid-wrap .tile")].find((t) => t.querySelector(".tile-name")?.textContent === "img.png");
  check("img_thumb_attempt", itile && itile.dataset.thumb !== undefined);
  itile.scrollIntoView();
  await sleep(250);
  check("img_thumb_done", itile && itile.dataset.thumb === "done" && !!itile.querySelector("img.tile-thumb"));
  // Group by in the grid too.
  document.getElementById("act-appearance").click();
  await sleep(50);
  const gsel2 = document.getElementById("appearance-group");
  gsel2.value = "type"; gsel2.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(80);
  check("group_grid_sections", document.querySelectorAll("#grid-wrap .group-grid").length === 12 && document.querySelectorAll("#grid-wrap .group-head").length === 12);
  gsel2.value = "none"; gsel2.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(50);
  // Leave the stored tab zoom at Medium so later runs start clean.
  document.querySelector('#appearance-panel [data-zoom="1"]').click();
  document.getElementById("view-details").click();

  // 10. Empty state: name filter with no match, then Clear search.
  const search = document.getElementById("search");
  search.value = "zzz-no-match";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(80);
  check("empty_state_nomatch", !document.getElementById("empty").hidden && document.querySelector("#empty h2").textContent.includes("No matches") && !document.getElementById("empty-clear-search").hidden);
  document.getElementById("empty-clear-search").click();
  await sleep(80);
  check("empty_clear_search", document.getElementById("empty").hidden && rows().length > 0 && search.value === "");

  window.__dndResult = JSON.stringify(out);
})();
