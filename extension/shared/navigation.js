(() => {
  "use strict";

  // Keep the source page when moving between the manager and its dashboards.
  const value = new URL(location.href).searchParams.get("sourceTabId");
  if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(Number(value))) {
    return;
  }
  for (const link of document.querySelectorAll("a[data-source-link]")) {
    const url = new URL(link.href);
    url.searchParams.set("sourceTabId", value);
    link.href = url.href;
    link.hidden = false;
  }
})();
