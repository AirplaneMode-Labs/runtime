import { BACKEND_TIER_RANK, type CapabilityProfile } from '../spec/capability-profile';
import type { MinProfile } from '../spec/manifest';

/**
 * The MinProfile rule from the manifest contract:
 * (min.gpu absent or 'none' or profile.gpu == 'webgpu') && (profile.ramGb == 0 || profile.ramGb >= min.ramGb)
 *   && profile.storageFreeGb >= min.storageFreeGb && profile.cores >= min.cores
 *   && rank(profile.backendTier) >= rank(min.backendTier). An empty MinProfile matches any device.
 * profile.ramGb 0 means the browser does not report its memory: unknown, never below a minimum (capability
 * profile 0.1.1, TD-84). Only a reported value below min.ramGb fails.
 */
export function satisfies(profile: CapabilityProfile, min: MinProfile): boolean {
  if (min.gpu === 'webgpu' && profile.gpu !== 'webgpu') return false;
  if (min.ramGb !== undefined && profile.ramGb > 0 && profile.ramGb < min.ramGb) return false;
  if (min.storageFreeGb !== undefined && profile.storageFreeGb < min.storageFreeGb) return false;
  if (min.cores !== undefined && profile.cores < min.cores) return false;
  if (
    min.backendTier !== undefined &&
    BACKEND_TIER_RANK[profile.backendTier] < BACKEND_TIER_RANK[min.backendTier]
  )
    return false;
  return true;
}
