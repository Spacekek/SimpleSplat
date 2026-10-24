// The single source of default experience settings, so every tool that writes a settings file
// agrees. Several independent copies of these values had drifted apart; these are the ones
// matching the settings already published in the wild, which means some producers change:
// `tonemapping` is 'linear' rather than 'none', `background.color` is black rather than 0.4
// grey, `bloom.intensity` is 0.1 rather than 1 (1 falls outside the authoring range in
// ranges.ts) and `grading.brightness` is 1 rather than 0.
// Frozen: `defaultSettings()` copies this, so a consumer mutating it would otherwise change
// every later call's result.
/** Default page and scene background, as normalized 0..1 rgb components. */
const DEFAULT_BACKGROUND_COLOR = Object.freeze([0, 0, 0]);
/** Default tonemapping curve. */
const DEFAULT_TONEMAPPING = 'linear';
/** Default vertical field of view, in degrees. */
// Annotated so the published declaration widens to `number`; without it the emitted type is
// the literal `75`, which bakes the value into the api.
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
const DEFAULT_CAMERA_FOV = 85;
const defaultCameraPose = (fit = 'environment') => {
    return fit === 'environment'
        ? { position: [0, 2, 0], target: [2, 2, 0], fov: DEFAULT_CAMERA_FOV }
        : { position: [2, 2, -2], target: [0, 0, 0], fov: DEFAULT_CAMERA_FOV };
};
/**
 * Default post-processing settings, with every effect disabled.
 *
 * @returns A fresh object; callers may mutate it freely.
 */
const defaultPostEffectSettings = () => ({
    sharpness: {
        enabled: false,
        amount: 0
    },
    bloom: {
        enabled: false,
        intensity: 0.1,
        blurLevel: 2
    },
    grading: {
        enabled: false,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        tint: [1, 1, 1]
    },
    vignette: {
        enabled: false,
        intensity: 0.5,
        inner: 0.3,
        outer: 0.75,
        curvature: 1
    },
    fringing: {
        enabled: false,
        intensity: 0.5
    }
});
/**
 * Default experience settings, shared by every tool that writes a settings file.
 *
 * @param fit - How to place the default camera. Defaults to `environment`.
 * @returns A fresh object; callers may mutate it freely.
 */
const defaultSettings = (fit = 'environment') => ({
    version: 2,
    tonemapping: DEFAULT_TONEMAPPING,
    highPrecisionRendering: false,
    background: {
        color: [...DEFAULT_BACKGROUND_COLOR]
    },
    postEffectSettings: defaultPostEffectSettings(),
    animTracks: [],
    cameras: [{ initial: defaultCameraPose(fit) }],
    annotations: [],
    startMode: 'default'
});

const assertObject = (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value;
};
const assertNumber = (value, path) => {
    if (typeof value !== 'number' || !isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
    }
    return value;
};
const assertString = (value, path) => {
    if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
    }
    return value;
};
const assertBoolean = (value, path) => {
    if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
    }
    return value;
};
const assertEnum = (value, allowed, path) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
    }
    return value;
};
const assertArray = (value, path) => {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
    }
    return value;
};
const assertNumberArray = (value, path) => {
    const arr = assertArray(value, path);
    for (let i = 0; i < arr.length; i++) {
        assertNumber(arr[i], `${path}[${i}]`);
    }
    return arr;
};
const assertTuple3 = (value, path) => {
    const arr = assertNumberArray(value, path);
    if (arr.length !== 3) {
        throw new Error(`${path} must have exactly 3 elements`);
    }
    return arr;
};

const validateAnimTrack$1 = (data, path) => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    if (obj.frameRate !== undefined)
        assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.target, ['camera'], `${path}.target`);
    assertEnum(obj.loopMode, ['none', 'repeat', 'pingpong'], `${path}.loopMode`);
    assertEnum(obj.interpolation, ['step', 'spline'], `${path}.interpolation`);
    if (obj.smoothness !== undefined)
        assertNumber(obj.smoothness, `${path}.smoothness`);
    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);
    return data;
};
const validateV1 = (data) => {
    const obj = assertObject(data, 'settings');
    const camera = assertObject(obj.camera, 'settings.camera');
    if (camera.fov !== undefined)
        assertNumber(camera.fov, 'settings.camera.fov');
    // Exactly 3 elements: migration casts these straight into v2 tuples, so any other arity
    // would validate here yet produce output that fails v2 validation.
    if (camera.position !== undefined)
        assertTuple3(camera.position, 'settings.camera.position');
    if (camera.target !== undefined)
        assertTuple3(camera.target, 'settings.camera.target');
    if (camera.startAnim !== undefined)
        assertEnum(camera.startAnim, ['none', 'orbit', 'animTrack'], 'settings.camera.startAnim');
    if (camera.animTrack != null)
        assertString(camera.animTrack, 'settings.camera.animTrack');
    const bg = assertObject(obj.background, 'settings.background');
    if (bg.color !== undefined)
        assertTuple3(bg.color, 'settings.background.color');
    if (obj.animTracks !== undefined) {
        const tracks = assertArray(obj.animTracks, 'settings.animTracks');
        tracks.forEach((t, i) => validateAnimTrack$1(t, `settings.animTracks[${i}]`));
    }
    return data;
};

const TONEMAPPING = ['none', 'linear', 'filmic', 'hejl', 'aces', 'aces2', 'neutral'];
const LOOP_MODES = ['none', 'repeat', 'pingpong'];
const INTERPOLATIONS = ['step', 'spline'];
const START_MODES = ['default', 'animTrack', 'annotation'];
const validateAnimTrack = (data, path) => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.loopMode, LOOP_MODES, `${path}.loopMode`);
    assertEnum(obj.interpolation, INTERPOLATIONS, `${path}.interpolation`);
    assertNumber(obj.smoothness, `${path}.smoothness`);
    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);
    assertNumberArray(vals.fov, `${path}.keyframes.values.fov`);
    return data;
};
const validateCamera = (data, path) => {
    const obj = assertObject(data, path);
    const initial = assertObject(obj.initial, `${path}.initial`);
    assertTuple3(initial.position, `${path}.initial.position`);
    assertTuple3(initial.target, `${path}.initial.target`);
    assertNumber(initial.fov, `${path}.initial.fov`);
    return data;
};
const validateAnnotation = (data, path) => {
    const obj = assertObject(data, path);
    assertTuple3(obj.position, `${path}.position`);
    assertString(obj.title, `${path}.title`);
    assertString(obj.text, `${path}.text`);
    validateCamera(obj.camera, `${path}.camera`);
    return data;
};
const validatePostEffects = (data, path) => {
    const obj = assertObject(data, path);
    const sh = assertObject(obj.sharpness, `${path}.sharpness`);
    assertBoolean(sh.enabled, `${path}.sharpness.enabled`);
    assertNumber(sh.amount, `${path}.sharpness.amount`);
    const bl = assertObject(obj.bloom, `${path}.bloom`);
    assertBoolean(bl.enabled, `${path}.bloom.enabled`);
    assertNumber(bl.intensity, `${path}.bloom.intensity`);
    assertNumber(bl.blurLevel, `${path}.bloom.blurLevel`);
    const gr = assertObject(obj.grading, `${path}.grading`);
    assertBoolean(gr.enabled, `${path}.grading.enabled`);
    assertNumber(gr.brightness, `${path}.grading.brightness`);
    assertNumber(gr.contrast, `${path}.grading.contrast`);
    assertNumber(gr.saturation, `${path}.grading.saturation`);
    assertTuple3(gr.tint, `${path}.grading.tint`);
    const vi = assertObject(obj.vignette, `${path}.vignette`);
    assertBoolean(vi.enabled, `${path}.vignette.enabled`);
    assertNumber(vi.intensity, `${path}.vignette.intensity`);
    assertNumber(vi.inner, `${path}.vignette.inner`);
    assertNumber(vi.outer, `${path}.vignette.outer`);
    assertNumber(vi.curvature, `${path}.vignette.curvature`);
    const fr = assertObject(obj.fringing, `${path}.fringing`);
    assertBoolean(fr.enabled, `${path}.fringing.enabled`);
    assertNumber(fr.intensity, `${path}.fringing.intensity`);
    return data;
};
const validateV2 = (data) => {
    const obj = assertObject(data, 'settings');
    if (obj.version !== 2) {
        throw new Error('settings.version must be 2');
    }
    assertEnum(obj.tonemapping, TONEMAPPING, 'settings.tonemapping');
    assertBoolean(obj.highPrecisionRendering, 'settings.highPrecisionRendering');
    if (obj.soundUrl !== undefined)
        assertString(obj.soundUrl, 'settings.soundUrl');
    const bg = assertObject(obj.background, 'settings.background');
    assertTuple3(bg.color, 'settings.background.color');
    if (bg.skyboxUrl !== undefined)
        assertString(bg.skyboxUrl, 'settings.background.skyboxUrl');
    validatePostEffects(obj.postEffectSettings, 'settings.postEffectSettings');
    const tracks = assertArray(obj.animTracks, 'settings.animTracks');
    tracks.forEach((t, i) => validateAnimTrack(t, `settings.animTracks[${i}]`));
    const cameras = assertArray(obj.cameras, 'settings.cameras');
    cameras.forEach((c, i) => validateCamera(c, `settings.cameras[${i}]`));
    const annotations = assertArray(obj.annotations, 'settings.annotations');
    annotations.forEach((a, i) => validateAnnotation(a, `settings.annotations[${i}]`));
    assertEnum(obj.startMode, START_MODES, 'settings.startMode');
    return data;
};

// Authoring bounds for experience settings, shared by the settings validators and by editor
// UIs that need slider ranges. Pure data with no imports, so a consumer can take these
// without pulling in the schema.
//
// These are *authoring* limits, not read limits: the viewer renders values outside them
// perfectly well, and settings in the wild contain some (see validate-limits.ts).
// `step` is UI granularity, not a constraint.
// These are published constants that the validators themselves read, so a consumer mutating
// one would silently change validation for everyone in the realm. Freeze rather than rely on
// `as const`, which is erased at runtime.
const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
};
/** Bounds for a camera's vertical field of view, in degrees. */
const CAMERA_FOV_RANGE = deepFreeze({
    min: 10,
    max: 120,
    step: 1
});
/** Bounds for each post-processing parameter. */
const POST_EFFECT_RANGES = deepFreeze({
    sharpness: {
        amount: { min: 0, max: 1, step: 0.01 }
    },
    bloom: {
        intensity: { min: 0, max: 0.1, step: 0.01 },
        blurLevel: { min: 1, max: 16, step: 1 }
    },
    grading: {
        brightness: { min: 0, max: 3, step: 0.01 },
        contrast: { min: 0.5, max: 1.5, step: 0.01 },
        saturation: { min: 0, max: 2, step: 0.01 }
    },
    vignette: {
        intensity: { min: 0, max: 1, step: 0.01 },
        inner: { min: 0, max: 3, step: 0.01 },
        outer: { min: 0, max: 3, step: 0.01 },
        curvature: { min: 0.01, max: 10, step: 0.01 }
    },
    fringing: {
        intensity: { min: 0, max: 100, step: 1 }
    }
});
// Annotated rather than `as const`: the annotation keeps them readonly while widening the
// values, so the published types do not bake in numbers we may want to relax later.
/** Bounds and size limits for camera animation tracks. Intentionally tight for now. */
const ANIM_TRACK_LIMITS = deepFreeze({
    duration: { min: 0.1, max: 600 },
    frameRate: { min: 1, max: 120 },
    smoothness: { min: 0, max: 1 },
    maxKeyframes: 1000,
    nameMax: 120,
    maxTracks: 10
});
/** Size limits for annotations. Intentionally tight for now. */
const ANNOTATION_LIMITS = deepFreeze({
    maxCount: 25,
    titleMax: 60,
    textMax: 280
});
/**
 * Test a field of view against {@link CAMERA_FOV_RANGE}.
 *
 * @param fov - Vertical field of view in degrees.
 * @returns Whether the value is within the authoring bounds.
 */
const isCameraFovInRange = (fov) => {
    return fov >= CAMERA_FOV_RANGE.min && fov <= CAMERA_FOV_RANGE.max;
};

// Authoring-limit checks, deliberately separate from the shape validation in v2.ts.
//
// Shape validation answers "can the viewer read this" and must keep accepting every settings
// file ever written. These limits answer "is this sane input from an editor" and are stricter
// — strictly enough that some existing data fails them. `bloom.intensity` is the known case:
// the range caps it at 0.1, while several older default objects wrote 1. So this runs only on
// request, via `validateSettings(x, { limits: true })`, and never on the viewer's read path.
const range = (value, bounds, path) => {
    if (value < bounds.min || value > bounds.max) {
        throw new Error(`${path} must be between ${bounds.min} and ${bounds.max}, got ${value}`);
    }
};
const maxLength = (value, max, path) => {
    if (value.length > max) {
        throw new Error(`${path} must be at most ${max} characters, got ${value.length}`);
    }
};
const maxCount = (value, max, path) => {
    if (value.length > max) {
        throw new Error(`${path} must have at most ${max} entries, got ${value.length}`);
    }
};
const validateLimitsV2 = (settings) => {
    const fx = settings.postEffectSettings;
    range(fx.sharpness.amount, POST_EFFECT_RANGES.sharpness.amount, 'settings.postEffectSettings.sharpness.amount');
    range(fx.bloom.intensity, POST_EFFECT_RANGES.bloom.intensity, 'settings.postEffectSettings.bloom.intensity');
    range(fx.bloom.blurLevel, POST_EFFECT_RANGES.bloom.blurLevel, 'settings.postEffectSettings.bloom.blurLevel');
    range(fx.grading.brightness, POST_EFFECT_RANGES.grading.brightness, 'settings.postEffectSettings.grading.brightness');
    range(fx.grading.contrast, POST_EFFECT_RANGES.grading.contrast, 'settings.postEffectSettings.grading.contrast');
    range(fx.grading.saturation, POST_EFFECT_RANGES.grading.saturation, 'settings.postEffectSettings.grading.saturation');
    range(fx.vignette.intensity, POST_EFFECT_RANGES.vignette.intensity, 'settings.postEffectSettings.vignette.intensity');
    range(fx.vignette.inner, POST_EFFECT_RANGES.vignette.inner, 'settings.postEffectSettings.vignette.inner');
    range(fx.vignette.outer, POST_EFFECT_RANGES.vignette.outer, 'settings.postEffectSettings.vignette.outer');
    range(fx.vignette.curvature, POST_EFFECT_RANGES.vignette.curvature, 'settings.postEffectSettings.vignette.curvature');
    range(fx.fringing.intensity, POST_EFFECT_RANGES.fringing.intensity, 'settings.postEffectSettings.fringing.intensity');
    // no count limit on cameras — the viewer only reads cameras[0], but the format allows more
    settings.cameras.forEach((camera, i) => {
        range(camera.initial.fov, CAMERA_FOV_RANGE, `settings.cameras[${i}].initial.fov`);
    });
    maxCount(settings.animTracks, ANIM_TRACK_LIMITS.maxTracks, 'settings.animTracks');
    settings.animTracks.forEach((track, i) => {
        const path = `settings.animTracks[${i}]`;
        maxLength(track.name, ANIM_TRACK_LIMITS.nameMax, `${path}.name`);
        range(track.duration, ANIM_TRACK_LIMITS.duration, `${path}.duration`);
        range(track.frameRate, ANIM_TRACK_LIMITS.frameRate, `${path}.frameRate`);
        if (!Number.isInteger(track.frameRate)) {
            throw new Error(`${path}.frameRate must be an integer, got ${track.frameRate}`);
        }
        range(track.smoothness, ANIM_TRACK_LIMITS.smoothness, `${path}.smoothness`);
        // Keyframe times are frame numbers: non-negative integers, strictly ascending, since
        // the spline is built from them in order.
        const { times, values } = track.keyframes;
        maxCount(times, ANIM_TRACK_LIMITS.maxKeyframes, `${path}.keyframes.times`);
        // At least one: `CubicSpline.calcKnots` derives its dimension as
        // `points.length / times.length`, so an empty track computes 0/0 and allocates
        // `new Array(NaN)`, which throws. A track the viewer cannot load is not valid input.
        if (times.length === 0) {
            throw new Error(`${path}.keyframes.times must have at least one keyframe`);
        }
        times.forEach((time, k) => {
            const at = `${path}.keyframes.times[${k}]`;
            if (time < 0) {
                throw new Error(`${at} must be non-negative, got ${time}`);
            }
            if (!Number.isInteger(time)) {
                throw new Error(`${at} must be an integer, got ${time}`);
            }
            if (k > 0 && time <= times[k - 1]) {
                throw new Error(`${at} must be greater than the previous frame, got ${time}`);
            }
        });
        // The track is flattened into one spline, so a mis-sized array silently stops the
        // animation rather than failing loudly at runtime.
        const vectorValues = times.length * 3;
        if (values.position.length !== vectorValues) {
            throw new Error(`${path}.keyframes.values.position must have 3 values per keyframe (${vectorValues}), got ${values.position.length}`);
        }
        if (values.target.length !== vectorValues) {
            throw new Error(`${path}.keyframes.values.target must have 3 values per keyframe (${vectorValues}), got ${values.target.length}`);
        }
        if (values.fov.length !== times.length) {
            throw new Error(`${path}.keyframes.values.fov must have 1 value per keyframe (${times.length}), got ${values.fov.length}`);
        }
        // No CAMERA_FOV_RANGE check on keyframes.values.fov: the validator this reaches parity
        // with does not bound those either, and they are splined rather than set directly.
    });
    maxCount(settings.annotations, ANNOTATION_LIMITS.maxCount, 'settings.annotations');
    settings.annotations.forEach((annotation, i) => {
        const path = `settings.annotations[${i}]`;
        maxLength(annotation.title, ANNOTATION_LIMITS.titleMax, `${path}.title`);
        maxLength(annotation.text, ANNOTATION_LIMITS.textMax, `${path}.text`);
        range(annotation.camera.initial.fov, CAMERA_FOV_RANGE, `${path}.camera.initial.fov`);
    });
};
// The v1 -> v2 migration substitutes defaults for falsy values — `frameRate: 0` becomes 30,
// `camera.fov: 0` becomes the default fov — so a post-migration check cannot see them and an
// explicitly invalid zero would pass. Check those fields as the caller supplied them.
//
// Only the coerced fields are checked here; everything else survives migration unchanged and
// is covered by validateLimitsV2.
const validateLimitsV1 = (settings) => {
    if (settings.camera.fov !== undefined) {
        range(settings.camera.fov, CAMERA_FOV_RANGE, 'settings.camera.fov');
    }
    settings.animTracks?.forEach((track, i) => {
        if (track.frameRate === undefined) {
            return;
        }
        const path = `settings.animTracks[${i}].frameRate`;
        range(track.frameRate, ANIM_TRACK_LIMITS.frameRate, path);
        if (!Number.isInteger(track.frameRate)) {
            throw new Error(`${path} must be an integer, got ${track.frameRate}`);
        }
    });
};

const migrateV1 = (input) => {
    // Copy first: callers own the object they pass in, and an API consumer holding a
    // reference should not see it rewritten underneath them.
    const settings = structuredClone(input);
    if (settings.animTracks) {
        settings.animTracks?.forEach((track) => {
            // some early settings did not have frameRate set on anim tracks
            if (!track.frameRate) {
                const defaultFrameRate = 30;
                track.frameRate = defaultFrameRate;
                const times = track.keyframes.times;
                for (let i = 0; i < times.length; i++) {
                    times[i] *= defaultFrameRate;
                }
            }
            // smoothness property added in v1.4.0
            // eslint-disable-next-line no-prototype-builtins -- preserve property lookup semantics
            if (!track.hasOwnProperty('smoothness')) {
                track.smoothness = 0;
            }
        });
    }
    else {
        // some scenes were published without animTracks
        settings.animTracks = [];
    }
    return settings;
};
const migrateAnimTrackV2 = (animTrackV1, fov) => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
            }
        }
    };
};
const migrateV2 = (v1) => {
    return {
        version: 2,
        // Not the shared default ('linear'): tonemapping applies unconditionally, so changing
        // it here would alter how existing v1 content renders.
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color || [0, 0, 0]
        },
        // Shared defaults rather than a private copy, so a migrated document lands inside the
        // authoring bounds and `validateSettings(v1, { limits: true })` reports the caller's
        // data instead of values invented here. Every effect is `enabled: false`, so which
        // numbers they carry is inert.
        postEffectSettings: defaultPostEffectSettings(),
        animTracks: v1.animTracks.map((animTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || DEFAULT_CAMERA_FOV);
        }),
        cameras: v1.camera.position && v1.camera.target
            ? [
                {
                    initial: {
                        position: v1.camera.position,
                        target: v1.camera.target,
                        fov: v1.camera.fov || DEFAULT_CAMERA_FOV
                    }
                }
            ]
            : [],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default'
    };
};
/**
 * Migrate settings of any supported version to the latest schema.
 *
 * Assumes valid input — call {@link validateSettings} first if the source is untrusted. Does
 * not mutate the object passed in.
 *
 * @param settings - Parsed contents of a settings file.
 * @returns The settings at the latest version.
 * @throws If the version is not supported.
 */
const importSettings = (settings) => {
    let result;
    const version = settings.version;
    if (version === undefined) {
        // v1 -> v2
        result = migrateV2(migrateV1(settings));
    }
    else if (version === 2) {
        // already v2
        result = settings;
    }
    else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
    return result;
};
/**
 * Validate unknown data against any supported settings schema version.
 *
 * @param settings - Data to validate.
 * @param options - See {@link ValidateOptions}.
 * @throws If the data is not valid settings, with a message naming the offending field.
 */
const validateSettings = (settings, options = {}) => {
    const obj = assertObject(settings, 'settings');
    const version = obj.version;
    if (version === undefined) {
        validateV1(settings);
        if (options.limits) {
            // Fields the migration would coerce, as the caller wrote them.
            validateLimitsV1(settings);
            // Everything else has to be checked against the migrated result, so a value the
            // migration derived can fail — v1 keyframe times in seconds are rescaled to
            // frames, for instance, and may land on a fraction. Say so, rather than reporting
            // a path and number the caller never wrote.
            let migrated;
            try {
                migrated = migrateV2(migrateV1(settings));
            }
            catch (err) {
                throw new Error(`settings could not be migrated for validation: ${err.message}`);
            }
            try {
                validateLimitsV2(migrated);
            }
            catch (err) {
                throw new Error(`${err.message} (checked after migrating from v1)`);
            }
        }
    }
    else if (version === 2) {
        validateV2(settings);
        if (options.limits) {
            validateLimitsV2(settings);
        }
    }
    else if (typeof version !== 'number') {
        throw new Error(`settings.version must be a number, got ${typeof version}`);
    }
    else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
};

export { ANIM_TRACK_LIMITS, ANNOTATION_LIMITS, CAMERA_FOV_RANGE, DEFAULT_BACKGROUND_COLOR, DEFAULT_CAMERA_FOV, DEFAULT_TONEMAPPING, POST_EFFECT_RANGES, defaultPostEffectSettings, defaultSettings, importSettings, isCameraFovInRange, validateSettings };
//# sourceMappingURL=settings.js.map
