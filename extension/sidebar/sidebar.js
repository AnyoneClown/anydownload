(() => {
  "use strict";

  const status = document.getElementById("sidebar-status");
  const fallbackLink = document.getElementById("open-manager-link");

  try {
    const managerUrl = browser.runtime.getURL("popup/popup.html?sidebar=1");
    fallbackLink.href = managerUrl;
    window.location.replace(managerUrl);
  } catch (error) {
    console.error("Unable to open the AnyDownload sidebar", error);
    status.textContent = "The media manager could not open automatically. Use the link below to try again.";
  }
})();
