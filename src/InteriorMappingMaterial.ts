import {
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  Color,
  Texture,
  Vector2,
  Vector3,
  type IUniform,
  type WebGLRenderer,
} from 'three';

type Shader = {
  uniforms: Record<string, IUniform>;
  vertexShader: string;
  fragmentShader: string;
};

import {
  vertexCommon,
  vertexBody,
  fragmentCommon,
  fragmentMapReplacement,
  fragmentRoughnessReplacement,
  fragmentMetalnessReplacement,
  fragmentNormalReplacement,
  fragmentOutput,
} from './shader/chunks.js';

export interface InteriorMappingMaterialParameters extends MeshStandardMaterialParameters {
  /** Interior atlas — the rooms texture sampled by the ray-march. */
  backAtlas: Texture;
  /** Columns in the back atlas grid. Default 4. */
  backAtlasCols?: number;
  /** Rows in the back atlas grid. Default 4. */
  backAtlasRows?: number;
  /** Apparent room depth in plane-local units. Default 1.0. */
  depth?: number;
  /** Back-wall fill factor in [0.05, 0.999]. Default 0.66. */
  backScale?: number;
  /** Plane size in world units (width, height). Must match the geometry. */
  planeSize: Vector2;
  /** Per-window seed (typically the window center). Controls cell picking. */
  windowId: Vector3;
  /**
   * Multiplier on the interior contribution before adding to the lit output.
   * Default (1, 1, 1). Tint warm + scale up for a "lights on" night look,
   * e.g. new Color(3.5, 3.0, 2.3).
   */
  interiorEmissive?: Color;
  /**
   * Fraction of interior light that bleeds through the opaque front layer,
   * tinted by the front color. 0 = front layer fully blocks the interior
   * (hard cutoff), 1 = no blocking. Default 0.25.
   */
  frontTransmission?: number;
  /**
   * Raises the effective opacity of the front layer. 1.0 = no change. >1 makes
   * semi-transparent pixels (sheer curtains, antialiased edges) read as more
   * opaque without re-authoring the texture. Useful for "lights on" night mode.
   * Computed as pow(alpha, 1/boost). Default 1.0.
   */
  frontAlphaBoost?: number;

  /** Optional front PBR atlas (RGBA: albedo + alpha). */
  frontAtlas?: Texture;
  /** Columns in the front atlas grid. Default 1. */
  frontAtlasCols?: number;
  /** Rows in the front atlas grid. Default 1. */
  frontAtlasRows?: number;
  /** Optional front normal atlas. Tangent-space normals. */
  frontNormalAtlas?: Texture;
  /** Normal map strength multiplier on .xy. Default 1.0. */
  frontNormalScale?: number;
  /** Optional front roughness atlas (samples .g). */
  frontRoughnessAtlas?: Texture;
  /** Optional front metalness atlas (samples .b). */
  frontMetalnessAtlas?: Texture;

  /**
   * Apparent glass thickness in plane-local units. Parallax-shifts the front
   * overlay sample so it appears to sit on the inside face of the pane rather
   * than glued to the outside surface. 0 disables. Default 0.
   */
  glassThickness?: number;
  /**
   * Magnitude (in cellUV units) of the interior ray-march sample perturbation
   * driven by the glass dirt map. Sells the "looking through real glass" effect.
   * Keep tiny (0.003–0.015). 0 disables. Default 0.
   */
  refractionStrength?: number;
  /**
   * Optional grayscale noise map used as a dirt/specular modulator over the
   * glass area (and as the source of the refraction perturbation). Centered
   * around 0.5; values >0.5 roughen the glass, <0.5 polish it.
   */
  glassDirtMap?: Texture;
  /**
   * How strongly the dirt map modulates roughness on the glass area. Default 0.35.
   */
  glassDirtStrength?: number;
  /**
   * Schlick fresnel sheen added to the glass area at grazing angles. This is
   * the primary "this is a pane of glass" cue. Default 0.0; example uses ~0.5.
   */
  glassFresnelStrength?: number;
  /** Tint of the fresnel sheen. Default cool white (0.85, 0.92, 1.0). */
  glassFresnelColor?: Color;
  /**
   * Additive brightness of dirt visible as smudges on the glass surface.
   * Different from glassDirtStrength (which is roughness modulation). Default 0.0.
   */
  glassSmudgeStrength?: number;
}

type InteriorUniforms = {
  uBackAtlas: IUniform<Texture | null>;
  uBackAtlasCols: IUniform<number>;
  uBackAtlasRows: IUniform<number>;
  uDepth: IUniform<number>;
  uBackScale: IUniform<number>;
  uPlaneSize: IUniform<Vector2>;
  uWindowId: IUniform<Vector3>;
  uInteriorEmissive: IUniform<Color>;
  uFrontTransmission: IUniform<number>;
  uFrontAlphaBoost: IUniform<number>;
  uFrontAtlas: IUniform<Texture | null>;
  uFrontAtlasCols: IUniform<number>;
  uFrontAtlasRows: IUniform<number>;
  uFrontNormalAtlas: IUniform<Texture | null>;
  uFrontNormalScale: IUniform<number>;
  uFrontRoughnessAtlas: IUniform<Texture | null>;
  uFrontMetalnessAtlas: IUniform<Texture | null>;
  uGlassThickness: IUniform<number>;
  uRefractionStrength: IUniform<number>;
  uGlassDirtMap: IUniform<Texture | null>;
  uGlassDirtStrength: IUniform<number>;
  uGlassFresnelStrength: IUniform<number>;
  uGlassFresnelColor: IUniform<Color>;
  uGlassSmudgeStrength: IUniform<number>;
};

export class InteriorMappingMaterial extends MeshStandardMaterial {
  readonly isInteriorMappingMaterial = true;

  /** Custom uniforms — shared into the patched MeshStandardMaterial shader. */
  readonly interiorUniforms: InteriorUniforms;

  constructor(params: InteriorMappingMaterialParameters) {
    const { backAtlas, planeSize, windowId, ...std } = params;

    // Strip non-standard fields before passing to MeshStandardMaterial.
    const stdParams: MeshStandardMaterialParameters = { ...std };
    delete (stdParams as Record<string, unknown>).backAtlasCols;
    delete (stdParams as Record<string, unknown>).backAtlasRows;
    delete (stdParams as Record<string, unknown>).depth;
    delete (stdParams as Record<string, unknown>).backScale;
    delete (stdParams as Record<string, unknown>).frontAtlas;
    delete (stdParams as Record<string, unknown>).frontAtlasCols;
    delete (stdParams as Record<string, unknown>).frontAtlasRows;
    delete (stdParams as Record<string, unknown>).frontNormalAtlas;
    delete (stdParams as Record<string, unknown>).frontNormalScale;
    delete (stdParams as Record<string, unknown>).frontRoughnessAtlas;
    delete (stdParams as Record<string, unknown>).frontMetalnessAtlas;
    delete (stdParams as Record<string, unknown>).interiorEmissive;
    delete (stdParams as Record<string, unknown>).frontTransmission;
    delete (stdParams as Record<string, unknown>).frontAlphaBoost;
    delete (stdParams as Record<string, unknown>).glassThickness;
    delete (stdParams as Record<string, unknown>).refractionStrength;
    delete (stdParams as Record<string, unknown>).glassDirtMap;
    delete (stdParams as Record<string, unknown>).glassDirtStrength;
    delete (stdParams as Record<string, unknown>).glassFresnelStrength;
    delete (stdParams as Record<string, unknown>).glassFresnelColor;
    delete (stdParams as Record<string, unknown>).glassSmudgeStrength;

    super(stdParams);

    this.interiorUniforms = {
      uBackAtlas:           { value: backAtlas },
      uBackAtlasCols:       { value: params.backAtlasCols ?? 4 },
      uBackAtlasRows:       { value: params.backAtlasRows ?? 4 },
      uDepth:               { value: params.depth ?? 1.0 },
      uBackScale:           { value: params.backScale ?? 0.66 },
      uPlaneSize:           { value: planeSize.clone() },
      uWindowId:            { value: windowId.clone() },
      uInteriorEmissive:    { value: (params.interiorEmissive ?? new Color(1, 1, 1)).clone() },
      uFrontTransmission:   { value: params.frontTransmission ?? 0.25 },
      uFrontAlphaBoost:     { value: params.frontAlphaBoost ?? 1.0 },
      uFrontAtlas:          { value: params.frontAtlas ?? null },
      uFrontAtlasCols:      { value: params.frontAtlasCols ?? 1 },
      uFrontAtlasRows:      { value: params.frontAtlasRows ?? 1 },
      uFrontNormalAtlas:    { value: params.frontNormalAtlas ?? null },
      uFrontNormalScale:    { value: params.frontNormalScale ?? 1.0 },
      uFrontRoughnessAtlas: { value: params.frontRoughnessAtlas ?? null },
      uFrontMetalnessAtlas: { value: params.frontMetalnessAtlas ?? null },
      uGlassThickness:      { value: params.glassThickness ?? 0.0 },
      uRefractionStrength:  { value: params.refractionStrength ?? 0.0 },
      uGlassDirtMap:        { value: params.glassDirtMap ?? null },
      uGlassDirtStrength:   { value: params.glassDirtStrength ?? 0.35 },
      uGlassFresnelStrength:{ value: params.glassFresnelStrength ?? 0.0 },
      uGlassFresnelColor:   { value: (params.glassFresnelColor ?? new Color(0.85, 0.92, 1.0)).clone() },
      uGlassSmudgeStrength: { value: params.glassSmudgeStrength ?? 0.0 },
    };

    this.applyDefines();
  }

  /** Set/replace the interior atlas. */
  setBackAtlas(tex: Texture): void {
    this.interiorUniforms.uBackAtlas.value = tex;
  }

  /** Set the front albedo atlas (RGBA). Pass null to remove. */
  setFrontAtlas(tex: Texture | null, cols = 1, rows = 1): void {
    this.interiorUniforms.uFrontAtlas.value = tex;
    this.interiorUniforms.uFrontAtlasCols.value = cols;
    this.interiorUniforms.uFrontAtlasRows.value = rows;
    this.applyDefines();
  }

  setFrontNormalAtlas(tex: Texture | null, scale = 1.0): void {
    this.interiorUniforms.uFrontNormalAtlas.value = tex;
    this.interiorUniforms.uFrontNormalScale.value = scale;
    this.applyDefines();
  }

  setFrontRoughnessAtlas(tex: Texture | null): void {
    this.interiorUniforms.uFrontRoughnessAtlas.value = tex;
    this.applyDefines();
  }

  setFrontMetalnessAtlas(tex: Texture | null): void {
    this.interiorUniforms.uFrontMetalnessAtlas.value = tex;
    this.applyDefines();
  }

  setGlassDirtMap(tex: Texture | null): void {
    this.interiorUniforms.uGlassDirtMap.value = tex;
    this.applyDefines();
  }

  /** Mirror the texture presence into shader #defines so onBeforeCompile branches correctly. */
  private applyDefines(): void {
    this.defines = this.defines ?? {};
    const u = this.interiorUniforms;
    const toggle = (key: string, on: boolean) => {
      if (on) this.defines![key] = '';
      else delete this.defines![key];
    };
    toggle('HAS_FRONT_ATLAS',    !!u.uFrontAtlas.value);
    toggle('HAS_FRONT_NORMAL',   !!u.uFrontNormalAtlas.value);
    toggle('HAS_FRONT_ROUGHNESS',!!u.uFrontRoughnessAtlas.value);
    toggle('HAS_FRONT_METALNESS',!!u.uFrontMetalnessAtlas.value);
    toggle('HAS_GLASS_DIRT',     !!u.uGlassDirtMap.value);
    this.needsUpdate = true;
  }

  override onBeforeCompile = (shader: Shader, _renderer: WebGLRenderer): void => {
    Object.assign(shader.uniforms, this.interiorUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexCommon}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${vertexBody}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentCommon}`)
      .replace('#include <map_fragment>', fragmentMapReplacement)
      .replace('#include <roughnessmap_fragment>', fragmentRoughnessReplacement)
      .replace('#include <metalnessmap_fragment>', fragmentMetalnessReplacement)
      .replace('#include <normal_fragment_maps>', fragmentNormalReplacement)
      // Inject BEFORE tonemapping so the linear-space interior gets the same
      // tonemap + color-space conversion as the rest of the lit output.
      .replace(
        '#include <tonemapping_fragment>',
        `${fragmentOutput}\n#include <tonemapping_fragment>`,
      );
  };

  /** Hot-reload-friendly clone of the live runtime knobs. */
  get depth(): number       { return this.interiorUniforms.uDepth.value; }
  set depth(v: number)      { this.interiorUniforms.uDepth.value = v; }
  get backScale(): number   { return this.interiorUniforms.uBackScale.value; }
  set backScale(v: number)  { this.interiorUniforms.uBackScale.value = v; }
  get interiorEmissive(): Color { return this.interiorUniforms.uInteriorEmissive.value; }
  set interiorEmissive(c: Color) { this.interiorUniforms.uInteriorEmissive.value.copy(c); }
  get frontTransmission(): number  { return this.interiorUniforms.uFrontTransmission.value; }
  set frontTransmission(v: number) { this.interiorUniforms.uFrontTransmission.value = v; }
  get frontAlphaBoost(): number    { return this.interiorUniforms.uFrontAlphaBoost.value; }
  set frontAlphaBoost(v: number)   { this.interiorUniforms.uFrontAlphaBoost.value = v; }
  get glassThickness(): number     { return this.interiorUniforms.uGlassThickness.value; }
  set glassThickness(v: number)    { this.interiorUniforms.uGlassThickness.value = v; }
  get refractionStrength(): number { return this.interiorUniforms.uRefractionStrength.value; }
  set refractionStrength(v: number){ this.interiorUniforms.uRefractionStrength.value = v; }
  get glassDirtStrength(): number  { return this.interiorUniforms.uGlassDirtStrength.value; }
  set glassDirtStrength(v: number) { this.interiorUniforms.uGlassDirtStrength.value = v; }
  get glassFresnelStrength(): number  { return this.interiorUniforms.uGlassFresnelStrength.value; }
  set glassFresnelStrength(v: number) { this.interiorUniforms.uGlassFresnelStrength.value = v; }
  get glassFresnelColor(): Color   { return this.interiorUniforms.uGlassFresnelColor.value; }
  set glassFresnelColor(c: Color)  { this.interiorUniforms.uGlassFresnelColor.value.copy(c); }
  get glassSmudgeStrength(): number  { return this.interiorUniforms.uGlassSmudgeStrength.value; }
  set glassSmudgeStrength(v: number) { this.interiorUniforms.uGlassSmudgeStrength.value = v; }
}
