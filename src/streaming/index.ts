/**
 * three-fenestra streaming layer
 *
 * Requires `@supabase/supabase-js` to be installed:
 *   npm install @supabase/supabase-js
 */

export { TextureStreamCache }      from './TextureStreamCache.js';
export { WindowStateManager }      from './WindowStateManager.js';
export { SupabaseShaderStream }    from './SupabaseShaderStream.js';

export type {
  TextureStreamCacheOptions,
} from './TextureStreamCache.js';

export type {
  WindowMachineState,
  WindowStateManagerOptions,
} from './WindowStateManager.js';

export type {
  ShaderStreamOptions,
  SceneHydrationCallback,
  PresenceCallback,
} from './SupabaseShaderStream.js';

export type {
  WindowStateRow,
  BuildingWindowStateRow,
  RealtimeChangeEvent,
  UniformBroadcast,
  PresencePayload,
  UniformSnapshot,
  TextureSnapshot,
} from './types.js';

export {
  rowToUniformSnapshot,
  rowToTextureSnapshot,
  DEFAULT_WINDOW_STATE,
} from './types.js';
