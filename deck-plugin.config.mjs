// Excalidraw loads a translation only when its UI language is not English, and Deck never sets
// one. Bundled, the other 50-odd were 2.2MB of a plugin Deck imports on every start, so each is
// replaced by an empty module. English stays, as the fallback every lookup ends at.
export const esbuildPlugins = [{
  name: "excalidraw-english-only",
  setup(b) {
    // esbuild's filter is Go regex, which has no lookahead, so English is let through here.
    b.onResolve({ filter: /\/locales\/[^/]+\.js$/ }, (a) =>
      /\/locales\/en-[^/]+\.js$/.test(a.path) ? undefined : { path: a.path, namespace: "empty-locale" });
    b.onLoad({ filter: /.*/, namespace: "empty-locale" }, () => ({ contents: "export default {};" }));
  },
}];
