try {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
} catch {
  // ignore
}
