// Build-time constants injected by demo/vite.config.ts (`define`). Declared here so
// `npm run typecheck` passes without the generated fixture.

/** JSON text of demo/public/fixture/trust-root.json: {keyId, publicKeyHex, note}. */
declare const __DEMO_TRUST_ROOT__: string;
/** First 12 characters of GITHUB_SHA in the Pages workflow, 'local' elsewhere. */
declare const __DEMO_BUILD__: string;
/**
 * JSON text describing the bundled test model, written by demo/tools/make-fixture.mjs when
 * DEMO_MODELS=1 (demo/public/models/trust-root.json) and `{"bundled":false}` otherwise:
 * {bundled, keyId, publicKeyHex, manifestPath, descriptorEntryId, totalBytes, modelName}.
 */
declare const __DEMO_MODELS__: string;
