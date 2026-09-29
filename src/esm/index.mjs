// ESM entry point. Re-exports the CommonJS build rather than shipping a
// second copy of the SDK: two copies would each hold their own module state
// (the AsyncLocalStorage behind withContext), so context set through `import`
// would be invisible to code loaded through `require`. Named imports from
// CommonJS keep default-export interop out of the picture for Node and
// bundlers alike. Keep this list in sync with src/index.ts — the package test
// fails if they differ.
export {
  SDK_VERSION,
  SignalVaultBlockedError,
  SignalVaultClient,
  SignalVaultUnavailableError,
  normalizeBaseUrl,
} from './index.js';
import { SignalVaultClient } from './index.js';
export default SignalVaultClient;
