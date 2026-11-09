// Build-time rewrite of the endpoints @huggingface/transformers ships as defaults (T1-S2-08).
//
// The backend adapter always overrides the first two at run time (env.remoteHost, and the ONNX
// Runtime wasmPaths prefix on a CDN); the third sits on the Node-only HF_TOKEN code path, which a
// browser never takes. Rewriting all three in the bundle means a built demo contains no endpoint of
// Hugging Face or a CDN, so even a bypassed override could not reach one. The build fails if a literal
// is not found, so a library update is reviewed; test/tools/dist-url-inventory.mjs then proves the
// build holds no listed host, as an https:// string or as a bare name.

export const ENGINE_DEFAULTS: [string, string][] = [
  ['remoteHost: "https://huggingface.co/"', 'remoteHost: "https://invalid.invalid/"'],
  [
    '`https://cdn.jsdelivr.net/npm/onnxruntime-web@${',
    '`https://invalid.invalid/onnxruntime-web@${',
  ],
  // the host allow-list of the HF_TOKEN Authorization header (a Node-only code path)
  ['["huggingface.co", "hf.co"]', '["invalid.invalid"]'],
];

export const neutraliseEngineDefaults = {
  name: 'neutralise-engine-defaults',
  apply: 'build' as const,
  transform(code: string, id: string): { code: string; map: null } | null {
    if (!/@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/.test(id)) return null;
    let out = code;
    for (const [from, to] of ENGINE_DEFAULTS) {
      if (!out.includes(from))
        throw new Error(
          `transformers.web.js no longer contains ${from}: review the engine defaults`,
        );
      out = out.split(from).join(to);
    }
    return { code: out, map: null };
  },
};
