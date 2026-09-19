(() => {
  "use strict";

  // Keep the source page when moving between the manager and its dashboards.
  const page = new URL(location.href);
  const value = page.searchParams.get("sourceTabId");
  const validSource = /^\d+$/.test(value || "") && Number.isSafeInteger(Number(value));
  const workspace = globalThis.parent?.AnyDownloadWorkspace;
  const embedded = page.searchParams.get("embedded") === "1" && workspace;
  if (embedded) document.documentElement.classList.add("embedded-workspace");
  for (const link of document.querySelectorAll("a[data-source-link]")) {
    const url = new URL(link.href);
    if (url.protocol !== page.protocol || url.host !== page.host) continue;
    if (validSource) {
      url.searchParams.set("sourceTabId", value);
      link.href = url.href;
      link.hidden = false;
    }
    const view = url.pathname === "/popup/popup.html" ? "media"
      : /^\/(history|tracking|sync|integrations|upload)\/\1\.html$/.exec(url.pathname)?.[1];
    if (embedded && view) {
      link.addEventListener("click", (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        workspace.open(view, view === "upload" ? url.search : "");
      });
    }
  }
})();
