// Browser module no longer used — scraper.js now uses plain fetch()
// Kept as stub for compatibility
export const getBrowserContext = async () => ({ browser: null, context: null });
export const closeBrowser = async () => {};
export const reWarmCloudflare = async () => {};
export const safeNavigate = async () => true;
export const waitForCloudflare = async () => true;
