// Shader chunks injected into MeshStandardMaterial via onBeforeCompile.
//
// Compositing model:
//   - The interior ray-march result is treated as ALREADY-LIT pixels (the rooms texture
//     is pre-shaded), so it is added to gl_FragColor AFTER all PBR lighting runs.
//   - The front atlas (albedo + alpha) drives diffuseColor.rgb. Where front alpha = 0
//     (the glass area), diffuseColor.rgb is forced to 0 so direct diffuse lighting does
//     not paint over the interior. Specular/fresnel from the GGX BRDF still runs across
//     the whole surface, giving the glass a real highlight.
//   - Mesh alpha is always 1.0: the window is opaque from the camera's perspective; the
//     interior IS the back of the surface, not a transparent hole.

export const vertexCommon = /* glsl */ `
  varying vec2 vInteriorLocalXY;
  varying vec3 vInteriorCameraLocal;
  uniform vec2 uPlaneSize;
`;

export const vertexBody = /* glsl */ `
  vInteriorLocalXY = position.xy / uPlaneSize;
  vec3 _imCamLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vInteriorCameraLocal = vec3(
    _imCamLocal.xy / uPlaneSize,
    _imCamLocal.z / max(uPlaneSize.x, uPlaneSize.y)
  );
`;

export const fragmentCommon = /* glsl */ `
  varying vec2 vInteriorLocalXY;
  varying vec3 vInteriorCameraLocal;

  uniform sampler2D uBackAtlas;
  uniform float uBackAtlasCols;
  uniform float uBackAtlasRows;
  uniform float uDepth;
  uniform float uBackScale;
  uniform vec3  uWindowId;
  uniform vec3  uInteriorEmissive;
  uniform float uFrontTransmission;
  uniform float uFrontAlphaBoost;
  uniform float uGlassThickness;
  uniform float uRefractionStrength;
  uniform float uGlassDirtStrength;
  uniform float uGlassFresnelStrength;
  uniform vec3  uGlassFresnelColor;
  uniform float uGlassSmudgeStrength;

  // Front cols/rows are always declared (cheap floats); samplers are gated by #define.
  uniform float uFrontAtlasCols;
  uniform float uFrontAtlasRows;
  #ifdef HAS_FRONT_ATLAS
    uniform sampler2D uFrontAtlas;
  #endif
  #ifdef HAS_FRONT_NORMAL
    uniform sampler2D uFrontNormalAtlas;
    uniform float uFrontNormalScale;
  #endif
  #ifdef HAS_FRONT_ROUGHNESS
    uniform sampler2D uFrontRoughnessAtlas;
  #endif
  #ifdef HAS_FRONT_METALNESS
    uniform sampler2D uFrontMetalnessAtlas;
  #endif
  #ifdef HAS_GLASS_DIRT
    uniform sampler2D uGlassDirtMap;
  #endif

  float _imHash(vec3 p, float seed) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3) + seed);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  vec2 _imAtlasUV(vec2 cellUV, float cols, float rows, float seed) {
    float total = cols * rows;
    float idx   = floor(_imHash(uWindowId, seed) * total);
    float col   = mod(idx, cols);
    float row   = floor(idx / cols);
    vec2 cellSize   = vec2(1.0 / cols, 1.0 / rows);
    vec2 inset      = cellSize * 0.001;
    vec2 cellOrigin = vec2(col * cellSize.x, 1.0 - (row + 1.0) * cellSize.y) + inset;
    return cellOrigin + clamp(cellUV, 0.0, 1.0) * (cellSize - 2.0 * inset);
  }

  vec2 _imFrontUVAt(vec2 localXY) {
    return _imAtlasUV(localXY + 0.5, uFrontAtlasCols, uFrontAtlasRows, 7.13);
  }
  vec2 _imFrontUV() { return _imFrontUVAt(vInteriorLocalXY); }

  // Parallax-shift the local-XY where we sample the front overlay so it appears
  // to sit on the INSIDE face of a thin glass pane of thickness uGlassThickness.
  // Without this the overlay reads like a sticker glued to the outside.
  vec2 _imFrontShiftedXY() {
    vec3 origin = vec3(vInteriorLocalXY, 0.0);
    vec3 dir    = normalize(origin - vInteriorCameraLocal);
    // dir.z is negative when camera is in front of the plane (its expected case).
    // Step along the ray to depth -uGlassThickness.
    float dz = dir.z;
    float safe = (abs(dz) < 0.05) ? 0.05 * sign(dz + 1e-6) : dz;
    return vInteriorLocalXY + dir.xy * (-uGlassThickness / safe);
  }

  vec3 _imInteriorRGB(vec2 refractOffset) {
    vec3 origin = vec3(vInteriorLocalXY, 0.0);
    vec3 dir    = normalize(origin - vInteriorCameraLocal);
    vec3 boxMin = vec3(-0.5, -0.5, -uDepth);
    vec3 boxMax = vec3( 0.5,  0.5,  0.0);
    vec3 invDir = 1.0 / dir;
    vec3 tNear  = (boxMin - origin) * invDir;
    vec3 tFar   = (boxMax - origin) * invDir;
    vec3 tMax   = max(tNear, tFar);
    float t     = min(min(tMax.x, tMax.y), tMax.z);
    vec3 hit    = origin + dir * t;

    float bs      = clamp(uBackScale, 0.05, 0.999);
    float camDist = bs * uDepth / (1.0 - bs);
    float scale   = camDist / (camDist - hit.z);
    vec2 cellUV   = hit.xy * scale + 0.5 + refractOffset;
    vec2 atlasUV  = _imAtlasUV(cellUV, uBackAtlasCols, uBackAtlasRows, 0.0);
    return texture2D(uBackAtlas, atlasUV).rgb;
  }
`;

// Replaces <map_fragment>. Stashes interior color in a varying-scope local
// (_imInteriorEmissive) that the output injection reads back at the end.
export const fragmentMapReplacement = /* glsl */ `
  // Sample dirt once and reuse for refraction perturbation + roughness modulation.
  vec2 _imRefractOffset = vec2(0.0);
  float _imDirt = 0.0;
  #ifdef HAS_GLASS_DIRT
    vec3 _imDirtSample = texture2D(uGlassDirtMap, _imFrontUV()).rgb;
    _imDirt = _imDirtSample.r;
    _imRefractOffset = (_imDirtSample.rg - 0.5) * uRefractionStrength;
  #endif

  vec3 _imInterior = _imInteriorRGB(_imRefractOffset);
  float _imFrontA  = 0.0;

  #ifdef HAS_FRONT_ATLAS
    // Sample the overlay at the parallax-shifted XY so it reads as INSIDE the glass.
    vec4 _imFront = texture2D(uFrontAtlas, _imFrontUVAt(_imFrontShiftedXY()));
    // alphaBoost > 1 makes semi-transparent pixels read as more opaque (pow with 1/boost
    // is a gamma-like curve on alpha). Useful for night mode with sheer curtain textures
    // that would otherwise leak a lot of interior light.
    _imFrontA = pow(clamp(_imFront.a, 0.0, 1.0), 1.0 / max(uFrontAlphaBoost, 0.001));
    diffuseColor.rgb *= _imFront.rgb * _imFrontA;
  #else
    diffuseColor.rgb = vec3(0.0);
  #endif

  diffuseColor.a = 1.0;

  // Interior light transmission through the front layer. Where front alpha = 0 (glass),
  // the interior passes through unchanged. Where alpha = 1 (curtain), a fraction
  // (uFrontTransmission) of the interior bleeds through, tinted by the front color —
  // so a red curtain glows red against a lit room.
  vec3 _imLitRoom = _imInterior * uInteriorEmissive;
  #ifdef HAS_FRONT_ATLAS
    vec3  _imTransmitTint = mix(_imFront.rgb, vec3(1.0), 1.0 - _imFrontA);
    float _imTransmitAmt  = mix(uFrontTransmission, 1.0, 1.0 - _imFrontA);
    vec3 _imInteriorEmissive = _imLitRoom * _imTransmitTint * _imTransmitAmt;
  #else
    vec3 _imInteriorEmissive = _imLitRoom;
  #endif
`;

export const fragmentRoughnessReplacement = /* glsl */ `
  float roughnessFactor = roughness;
  #ifdef HAS_FRONT_ROUGHNESS
    roughnessFactor *= texture2D(uFrontRoughnessAtlas, _imFrontUV()).g;
  #endif
  #ifdef HAS_GLASS_DIRT
    // Dirt only roughens the glass area (where the front overlay alpha is ~0).
    // Centered noise around 0.5; positive contribution raises roughness, negative lowers.
    float _imGlassMask = 1.0 - _imFrontA;
    roughnessFactor += (_imDirt - 0.5) * uGlassDirtStrength * _imGlassMask;
    roughnessFactor = clamp(roughnessFactor, 0.0, 1.0);
  #endif
`;

export const fragmentMetalnessReplacement = /* glsl */ `
  float metalnessFactor = metalness;
  #ifdef HAS_FRONT_METALNESS
    metalnessFactor *= texture2D(uFrontMetalnessAtlas, _imFrontUV()).b;
  #endif
`;

// Replaces <normal_fragment_maps>. Builds a TBN aligned with the plane's local
// +X (tangent) and +Y (bitangent) — matches our windowGroup mesh orientation.
export const fragmentNormalReplacement = /* glsl */ `
  #ifdef HAS_FRONT_NORMAL
    vec3 _imNTex = texture2D(uFrontNormalAtlas, _imFrontUV()).xyz * 2.0 - 1.0;
    _imNTex.xy *= uFrontNormalScale;
    vec3 _imN = normalize(normal);
    vec3 _imT = normalize(vec3(1.0, 0.0, 0.0) - dot(vec3(1.0, 0.0, 0.0), _imN) * _imN);
    vec3 _imB = cross(_imN, _imT);
    normal = normalize(mat3(_imT, _imB, _imN) * _imNTex);
  #endif
`;

// Injected BEFORE <tonemapping_fragment>: adds the linear-space interior on top of the
// PBR-lit front layer so it receives the same tonemap + sRGB conversion as everything else.
export const fragmentOutput = /* glsl */ `
  gl_FragColor.rgb += _imInteriorEmissive;

  // ── Glass surface pass ──
  // Compositing model now: bottom = interior (already added above), top = a
  // visible glass surface layer that exists only where _imFrontA is ~0.
  // Two cues sell the surface: (1) Schlick fresnel sheen so the pane catches
  // sky/light at grazing angles, (2) the dirt noise becomes a faint additive
  // smudge so you literally see particles ON the glass in front of the room.
  float _imGlassSurfaceMask = 1.0 - _imFrontA;
  vec3 _imViewLocal = normalize(vInteriorCameraLocal - vec3(vInteriorLocalXY, 0.0));
  float _imNdotV   = clamp(_imViewLocal.z, 0.0, 1.0);
  float _imFresnel = pow(1.0 - _imNdotV, 5.0);
  gl_FragColor.rgb += uGlassFresnelColor * uGlassFresnelStrength * _imFresnel * _imGlassSurfaceMask;

  #ifdef HAS_GLASS_DIRT
    // Subtle bright dust/smudges sitting on the glass. View-angle weighted so
    // they catch most at grazing — same way real grime reads on a window.
    float _imSmudge = max(_imDirt - 0.45, 0.0) * (0.35 + 0.65 * _imFresnel);
    gl_FragColor.rgb += vec3(_imSmudge) * uGlassSmudgeStrength * _imGlassSurfaceMask;
  #endif
`;
