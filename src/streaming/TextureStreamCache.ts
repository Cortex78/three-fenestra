/**
 * TextureStreamCache
 *
 * LRU cache for THREE.Texture objects loaded from URLs.
 *
 * Design goals:
 *  - Never decode the same URL twice while it's still in cache.
 *  - Single in-flight promise per URL: concurrent requests for the same URL
 *    share one TextureLoader call (no duplicate network requests).
 *  - Evict oldest entries when capacity is reached, disposing GPU memory.
 *  - Progressive loading: if a thumb URL is provided, resolve immediately with
 *    the thumbnail texture, then replace it with the full-res texture on load.
 *  - URL allowlist: rejects URLs from untrusted origins to prevent SSRF.
 */

import {
  TextureLoader,
  Texture,
  SRGBColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
} from 'three';

export interface TextureStreamCacheOptions {
  /** Maximum number of textures to keep in cache. Default 64. */
  maxEntries?: number;
  /** Maximum anisotropy to request. Default 8. */
  anisotropy?: number;
  /**
   * Allowlist of URL origins. If provided, any URL whose origin is not in this
   * set will be rejected. Pass `['*']` to disable origin checking.
   * Default: `['*']` (no restriction).
   */
  allowedOrigins?: string[];
  /**
   * Called when a texture is evicted from cache (for diagnostics).
   */
  onEvict?: (url: string) => void;
}

interface CacheEntry {
  texture: Texture;
  url:     string;
  /** Epoch milliseconds — used for LRU ordering. */
  lastUsed: number;
  /** Pending promise for in-flight loads. */
  pending?: Promise<Texture>;
}

export class TextureStreamCache {
  private readonly cache    = new Map<string, CacheEntry>();
  private readonly loader   = new TextureLoader();
  private readonly maxEntries: number;
  private readonly anisotropy: number;
  private readonly allowedOrigins: string[] | null;
  private readonly onEvict?: (url: string) => void;

  constructor(opts: TextureStreamCacheOptions = {}) {
    this.maxEntries    = opts.maxEntries    ?? 64;
    this.anisotropy    = opts.anisotropy    ?? 8;
    this.allowedOrigins =
      !opts.allowedOrigins || opts.allowedOrigins.includes('*')
        ? null
        : opts.allowedOrigins;
    this.onEvict = opts.onEvict;
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

  /**
   * Load a texture from `url`.
   *
   * - If already cached: returns the cached texture synchronously (via resolved promise).
   * - If in-flight: returns the same promise (deduplication).
   * - Otherwise: starts a new load.
   */
  async load(url: string): Promise<Texture> {
    this.validateUrl(url);

    const existing = this.cache.get(url);
    if (existing) {
      existing.lastUsed = Date.now();
      // If still loading, await the existing promise
      if (existing.pending) return existing.pending;
      return existing.texture;
    }

    // Start a new load
    const entry: CacheEntry = {
      texture:  new Texture(),  // placeholder — replaced on load
      url,
      lastUsed: Date.now(),
    };

    entry.pending = this.loader.loadAsync(url).then((tex) => {
      this.configure(tex);
      entry.texture = tex;
      entry.pending = undefined;
      return tex;
    }).catch((err) => {
      // Remove failed entry so a retry can succeed
      this.cache.delete(url);
      throw err;
    });

    this.cache.set(url, entry);
    this.evictIfNeeded();
    return entry.pending;
  }

  /**
   * Progressive load: immediately resolve with `thumbUrl` texture while the
   * full-res `fullUrl` loads in the background.
   *
   * Returns an array:
   *   [0] thumbnail texture (fast)
   *   [1] full-res texture  (via async callback when ready)
   *
   * @param onFullResReady  Called when the full-res texture is decoded.
   */
  async loadProgressive(
    thumbUrl:     string,
    fullUrl:      string,
    onFullResReady: (tex: Texture) => void,
  ): Promise<Texture> {
    const thumb = await this.load(thumbUrl);

    // Start full-res in the background
    this.load(fullUrl)
      .then(onFullResReady)
      .catch(console.warn);

    return thumb;
  }

  /**
   * Returns the cached texture synchronously, or `null` if not yet loaded.
   * Useful for checking without triggering a load.
   */
  peek(url: string): Texture | null {
    const entry = this.cache.get(url);
    if (!entry || entry.pending) return null;
    entry.lastUsed = Date.now();
    return entry.texture;
  }

  /** Explicitly evict a URL from cache and dispose the texture. */
  evict(url: string): void {
    const entry = this.cache.get(url);
    if (!entry) return;
    if (!entry.pending) entry.texture.dispose();
    this.cache.delete(url);
    this.onEvict?.(url);
  }

  /** Dispose all cached textures and clear the cache. */
  dispose(): void {
    for (const entry of this.cache.values()) {
      if (!entry.pending) entry.texture.dispose();
    }
    this.cache.clear();
  }

  get size(): number { return this.cache.size; }

  // ─────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────

  private configure(tex: Texture): void {
    tex.colorSpace      = SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter       = LinearMipmapLinearFilter;
    tex.magFilter       = LinearFilter;
    tex.wrapS           = ClampToEdgeWrapping;
    tex.wrapT           = ClampToEdgeWrapping;
    tex.anisotropy      = this.anisotropy;
    tex.needsUpdate     = true;
  }

  /** Evict the least-recently-used entry when over capacity. */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxEntries) return;

    let oldest: CacheEntry | null = null;
    for (const entry of this.cache.values()) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
    }
    if (oldest) this.evict(oldest.url);
  }

  private validateUrl(url: string): void {
    if (!this.allowedOrigins) return;  // no restriction
    try {
      const origin = new URL(url).origin;
      if (!this.allowedOrigins.includes(origin)) {
        throw new Error(
          `TextureStreamCache: URL origin "${origin}" is not in allowedOrigins.`,
        );
      }
    } catch {
      throw new Error(`TextureStreamCache: Invalid URL "${url}".`);
    }
  }
}
