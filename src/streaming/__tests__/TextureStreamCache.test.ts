/**
 * Unit tests for TextureStreamCache
 *
 * Strategy: mock THREE.TextureLoader so no real network or WebGL calls happen.
 * The cache logic (LRU, deduplication, origin validation, dispose) is tested
 * in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextureStreamCache } from '../TextureStreamCache.js';

// ─────────────────────────────────────────────────────────────
// Mock THREE
// ─────────────────────────────────────────────────────────────

// Lightweight Texture stand-in
class FakeTexture {
  disposed = false;
  needsUpdate = false;
  dispose() { this.disposed = true; }
}

// Controllable TextureLoader mock
// vi.fn() generic changed between vitest versions: use the single-arg form
const mockLoadAsync = vi.fn((url: string): Promise<FakeTexture> => Promise.reject(new Error(`no mock for ${url}`)));

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');
  return {
    ...actual,
    TextureLoader: class {
      loadAsync(url: string) { return mockLoadAsync(url); }
    },
    // Constants used in TextureStreamCache.configure()
    SRGBColorSpace:          'srgb',
    LinearFilter:            1006,
    LinearMipmapLinearFilter: 1008,
    ClampToEdgeWrapping:     1001,
  };
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeTexture(label = 'tex'): FakeTexture {
  const t = new FakeTexture();
  (t as unknown as { label: string }).label = label;
  return t;
}

function makeCache(opts?: ConstructorParameters<typeof TextureStreamCache>[0]) {
  return new TextureStreamCache(opts);
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockLoadAsync.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TextureStreamCache — basic load', () => {
  it('calls TextureLoader.loadAsync exactly once per URL', async () => {
    const tex  = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();
    const result = await cache.load('https://example.com/a.webp');

    expect(mockLoadAsync).toHaveBeenCalledOnce();
    expect(mockLoadAsync).toHaveBeenCalledWith('https://example.com/a.webp');
    expect(result).toBe(tex);
  });

  it('returns the cached texture on second call (no extra network request)', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();
    const r1 = await cache.load('https://example.com/a.webp');
    const r2 = await cache.load('https://example.com/a.webp');

    expect(mockLoadAsync).toHaveBeenCalledOnce();
    expect(r1).toBe(r2);
  });

  it('deduplicates concurrent requests for the same URL', async () => {
    let resolve!: (t: FakeTexture) => void;
    const promise = new Promise<FakeTexture>((r) => { resolve = r; });
    mockLoadAsync.mockReturnValueOnce(promise as Promise<FakeTexture>);

    const cache  = makeCache();
    const [p1, p2, p3] = [
      cache.load('https://example.com/b.webp'),
      cache.load('https://example.com/b.webp'),
      cache.load('https://example.com/b.webp'),
    ];

    expect(mockLoadAsync).toHaveBeenCalledOnce();  // only one load, not three

    const tex = makeTexture();
    resolve(tex as unknown as FakeTexture);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe(tex);
    expect(r2).toBe(tex);
    expect(r3).toBe(tex);
  });

  it('loads different URLs independently', async () => {
    const texA = makeTexture('A');
    const texB = makeTexture('B');
    mockLoadAsync
      .mockResolvedValueOnce(texA as unknown as FakeTexture)
      .mockResolvedValueOnce(texB as unknown as FakeTexture);

    const cache = makeCache();
    const [rA, rB] = await Promise.all([
      cache.load('https://example.com/a.webp'),
      cache.load('https://example.com/b.webp'),
    ]);

    expect(rA).toBe(texA);
    expect(rB).toBe(texB);
    expect(mockLoadAsync).toHaveBeenCalledTimes(2);
  });
});

describe('TextureStreamCache — peek', () => {
  it('returns null for an unknown URL', () => {
    const cache = makeCache();
    expect(cache.peek('https://example.com/unknown.webp')).toBeNull();
  });

  it('returns null while a URL is still loading', async () => {
    let _resolve!: (t: FakeTexture) => void;
    mockLoadAsync.mockReturnValueOnce(
      new Promise<FakeTexture>((r) => { _resolve = r; }) as Promise<FakeTexture>,
    );

    const cache = makeCache();
    const loadPromise = cache.load('https://example.com/c.webp');
    expect(cache.peek('https://example.com/c.webp')).toBeNull();

    _resolve(makeTexture() as unknown as FakeTexture);
    await loadPromise;
  });

  it('returns the texture synchronously after load completes', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();
    await cache.load('https://example.com/d.webp');
    expect(cache.peek('https://example.com/d.webp')).toBe(tex);
  });
});

describe('TextureStreamCache — LRU eviction', () => {
  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const evicted: string[] = [];
    const cache = makeCache({ maxEntries: 2, onEvict: (url) => evicted.push(url) });

    mockLoadAsync
      .mockResolvedValueOnce(makeTexture('a') as unknown as FakeTexture)
      .mockResolvedValueOnce(makeTexture('b') as unknown as FakeTexture)
      .mockResolvedValueOnce(makeTexture('c') as unknown as FakeTexture);

    await cache.load('https://example.com/a.webp');
    await cache.load('https://example.com/b.webp');

    expect(cache.size).toBe(2);
    expect(evicted).toHaveLength(0);

    // Loading a third entry must evict the LRU
    await cache.load('https://example.com/c.webp');

    expect(cache.size).toBe(2);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toBe('https://example.com/a.webp');
  });

  it('disposes the evicted texture GPU memory', async () => {
    const oldTex = makeTexture('old');
    const evictedTextures: FakeTexture[] = [];

    const cache = makeCache({
      maxEntries: 1,
      onEvict: (url) => {
        // Capture the texture that was in cache before eviction
        const t = cache.peek(url);
        if (t) evictedTextures.push(t as unknown as FakeTexture);
      },
    });

    mockLoadAsync
      .mockResolvedValueOnce(oldTex as unknown as FakeTexture)
      .mockResolvedValueOnce(makeTexture('new') as unknown as FakeTexture);

    await cache.load('https://example.com/old.webp');
    await cache.load('https://example.com/new.webp');

    // The old texture's dispose() should have been called
    expect(oldTex.disposed).toBe(true);
  });
});

describe('TextureStreamCache — explicit eviction', () => {
  it('removes the URL from cache', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();
    await cache.load('https://example.com/e.webp');

    expect(cache.size).toBe(1);
    cache.evict('https://example.com/e.webp');
    expect(cache.size).toBe(0);
  });

  it('disposes the texture GPU memory on evict', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();
    await cache.load('https://example.com/f.webp');
    cache.evict('https://example.com/f.webp');

    expect(tex.disposed).toBe(true);
  });

  it('is a no-op for unknown URLs', () => {
    const cache = makeCache();
    expect(() => cache.evict('https://example.com/unknown.webp')).not.toThrow();
  });
});

describe('TextureStreamCache — dispose', () => {
  it('disposes all textures and clears the cache', async () => {
    const texA = makeTexture('A');
    const texB = makeTexture('B');
    mockLoadAsync
      .mockResolvedValueOnce(texA as unknown as FakeTexture)
      .mockResolvedValueOnce(texB as unknown as FakeTexture);

    const cache = makeCache();
    await cache.load('https://example.com/a.webp');
    await cache.load('https://example.com/b.webp');

    cache.dispose();

    expect(cache.size).toBe(0);
    expect(texA.disposed).toBe(true);
    expect(texB.disposed).toBe(true);
  });
});

describe('TextureStreamCache — URL origin allowlist', () => {
  it('accepts URLs from allowed origins', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache({
      allowedOrigins: ['https://cdn.supabase.co'],
    });

    await expect(
      cache.load('https://cdn.supabase.co/textures/room.webp'),
    ).resolves.toBe(tex);
  });

  it('rejects URLs from disallowed origins', async () => {
    const cache = makeCache({
      allowedOrigins: ['https://cdn.supabase.co'],
    });

    await expect(
      cache.load('https://evil.example.com/malicious.webp'),
    ).rejects.toThrow('not in allowedOrigins');
  });

  it('accepts any origin when allowedOrigins is ["*"]', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache({ allowedOrigins: ['*'] });

    await expect(
      cache.load('https://any-host.example.com/tex.webp'),
    ).resolves.toBe(tex);
  });

  it('accepts any origin when allowedOrigins is omitted', async () => {
    const tex = makeTexture();
    mockLoadAsync.mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();   // no allowedOrigins

    await expect(
      cache.load('https://any-host.example.com/tex.webp'),
    ).resolves.toBe(tex);
  });

  it('rejects invalid URL strings', async () => {
    const cache = makeCache({ allowedOrigins: ['https://cdn.example.com'] });

    await expect(
      cache.load('not-a-url'),
    ).rejects.toThrow();
  });
});

describe('TextureStreamCache — failed loads', () => {
  it('removes failed entry so a retry can succeed', async () => {
    const tex = makeTexture();
    mockLoadAsync
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(tex as unknown as FakeTexture);

    const cache = makeCache();

    await expect(
      cache.load('https://example.com/flaky.webp'),
    ).rejects.toThrow('Network error');

    expect(cache.size).toBe(0);  // failed entry removed

    // Retry should succeed
    const result = await cache.load('https://example.com/flaky.webp');
    expect(result).toBe(tex);
    expect(mockLoadAsync).toHaveBeenCalledTimes(2);
  });
});

describe('TextureStreamCache — size tracking', () => {
  it('starts at zero', () => {
    expect(makeCache().size).toBe(0);
  });

  it('increments on each new load', async () => {
    mockLoadAsync
      .mockResolvedValueOnce(makeTexture() as unknown as FakeTexture)
      .mockResolvedValueOnce(makeTexture() as unknown as FakeTexture);

    const cache = makeCache({ maxEntries: 10 });
    await cache.load('https://example.com/1.webp');
    expect(cache.size).toBe(1);
    await cache.load('https://example.com/2.webp');
    expect(cache.size).toBe(2);
  });

  it('does not increment for repeated loads of the same URL', async () => {
    mockLoadAsync.mockResolvedValueOnce(makeTexture() as unknown as FakeTexture);

    const cache = makeCache();
    await cache.load('https://example.com/same.webp');
    await cache.load('https://example.com/same.webp');
    expect(cache.size).toBe(1);
  });
});
