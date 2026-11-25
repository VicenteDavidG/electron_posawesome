const { app } = require("electron");

/**
 * Configure electron-updater for GitHub Releases without auto-publishing
 * and without interrupting active POS sales or shifts.
 */
function setupAutoUpdater(logger) {
  if (process.env.LEAF_TEST_MODE === "1" || !app.isPackaged) {
    logger?.info("Auto-updater skipped (unpackaged or test mode).");
    return null;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    logger?.warn("electron-updater module not available.", { error: err });
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    logger?.info("Updater: checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    logger?.info("Updater: update available.", { version: info?.version });
  });

  autoUpdater.on("update-not-available", (info) => {
    logger?.info("Updater: no update available.", { version: info?.version });
  });

  autoUpdater.on("update-downloaded", (info) => {
    logger?.info("Updater: update downloaded and staged for next clean exit.", {
      version: info?.version,
    });
  });

  autoUpdater.on("error", (err) => {
    logger?.warn("Updater error (ignored safely).", { error: err });
  });

  // Trigger non-blocking check after startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger?.warn("Updater checkForUpdates failed.", { error: err });
    });
  }, 15000).unref();

  return autoUpdater;
}

module.exports = {
  setupAutoUpdater,
};
