// Evidence: read-only docs.perfectcorp.com JSON exports dated 2026-10-19.
// Paths below are literal documented paths; null means not verified.
const API = '/s2s/v2.0';
const HEX = /^#[\da-f]{6}$/i;

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function hex(value, name) {
  if (typeof value !== 'string' || !HEX.test(value)) throw new Error(`${name} must be #RRGGBB`);
  return value;
}

const source = fileId => ({ src_file_id: string(fileId, 'fileId') });
const withTemplate = (fileId, options = {}) => ({
  ...(options.srcFileUrl === undefined ? source(fileId) : { src_file_url: string(options.srcFileUrl, 'srcFileUrl') }),
  template_id: string(options.templateId, 'templateId'),
});
const withReference = (fileId, options = {}) => ({ ...source(fileId), ref_file_id: string(options.refFileId, 'refFileId') });

function hairColor(fileId, options = {}) {
  if (!Array.isArray(options.colors) || options.colors.length !== 2) throw new Error('colors must contain two #RRGGBB values');
  // The exported schema permits only "top". The palette order and line_offset
  // control the lower-color region; "bottom" is not a documented enum value.
  if (options.coloringSection !== undefined && options.coloringSection !== 'top') throw new Error('coloringSection must be top');
  return {
    ...source(fileId),
    pattern: {
      name: 'ombre',
      blend_strength: number(options.blendStrength ?? 50, 'blendStrength', 0, 100, true),
      line_offset: number(options.ombreLineOffset ?? 0, 'ombreLineOffset', -0.99, 0.99),
      coloring_section: options.coloringSection ?? 'top',
    },
    palettes: options.colors.map((color, i) => ({ color: hex(color, `colors[${i}]`), color_intensity: 100, shine_intensity: 50 })),
  };
}

function makeup(fileId, options = {}) {
  const effect = options.lipColor === undefined
    ? { category: 'skin_smooth', skinSmoothStrength: number(options.strength ?? 50, 'strength', 0, 100, true) }
    : {
      category: 'lip_color',
      shape: { name: 'original' },
      palettes: [{ color: hex(options.lipColor, 'lipColor'), texture: 'matte', colorIntensity: 80 }],
      style: { type: 'full' },
    };
  return { ...source(fileId), version: '1.0', effects: [effect] };
}

function nail(fileId, options = {}) {
  const fingers = ['thumb', 'index', 'middle', 'ring', 'little'];
  return {
    ...source(fileId), version: '1.0', effect_type: 'nail_polish',
    effects: fingers.map(finger => ({
      sub_type: 'color', finger: finger === 'little' ? 'pinky' : finger,
      color: hex(options.colors?.[finger], `colors.${finger}`),
      texture: 'cream', transparency: 0, reflection: 50, contrast: 50, roughness: 0,
    })),
  };
}

function ring(fileId, options = {}, stacked = false) {
  const refs = options.refFileIds;
  if (!Array.isArray(refs) || refs.length !== (stacked ? 2 : 1)) throw new Error(`refFileIds must contain ${stacked ? 'two' : 'one'} uploaded ring file ID(s)`);
  refs.forEach(ref => string(ref, 'refFileIds entry'));
  const parameter = {};
  if (options.finger !== undefined) parameter.ring_wearing_finger = number(options.finger, 'finger', 0, 4, true);
  if (options.location !== undefined) parameter.ring_wearing_location = number(options.location, 'location', 0, 1);
  return {
    ...source(fileId), ref_file_ids: refs,
    source_info: { name: fileId },
    object_infos: refs.map(name => ({ name, parameter: { ...parameter } })),
  };
}

function threeAngles(fileId, options = {}) {
  const ids = options.srcFileIds;
  if (!Array.isArray(ids) || ids.length !== 3) throw new Error('srcFileIds must contain three uploaded photos (front, right, left)');
  ids.forEach(id => string(id, 'srcFileIds entry'));
  return { src_file_ids: [...ids] };
}

function clothes(fileId, options = {}, version = 2) {
  if (version === 2 && options.templateId) return withTemplate(fileId, options);
  const categories = ['full_body', 'lower_body', 'upper_body', 'shoes', 'auto', ...(version === 4 ? ['outer'] : [])];
  if (!categories.includes(options.garmentCategory)) throw new Error(`garmentCategory must be one of: ${categories.join(', ')}`);
  return { ...withReference(fileId, options), garment_category: options.garmentCategory };
}

function facialColorTones(fileId, options = {}) {
  const payload = source(fileId);
  if (options.strictness !== undefined) {
    if (!['strict', 'high', 'medium', 'low', 'flexible'].includes(options.strictness)) throw new Error('Invalid strictness');
    payload.face_angle_strictness_level = options.strictness;
  }
  return payload;
}

function feature(id, label, doc, task, units, buildRequest, notes = [], filePath = `${API}/file`, schema = '', fileEvidence = null) {
  const evidence = part => `${doc}.yaml.json: ${part}`;
  return {
    id, label, filePath, taskPath: `${API}/task/${task}`, estimatedUnits: units, buildRequest,
    liveSupported: filePath !== null,
    verification: {
      filePath: { verified: filePath !== null, source: filePath === null ? null : fileEvidence ?? evidence(filePath.includes('/2d-vto/') ? 'POST file operation' : 'Integration Guide / Upload Endpoint') },
      taskPath: { verified: true, source: evidence('POST task operation') },
      request: { verified: true, source: evidence(schema || 'request schema') },
      estimatedUnits: { verified: units !== null, source: units === null ? null : evidence('Unit Consumption') },
    },
    notes,
  };
}

export const FEATURES = Object.freeze({
  'hair-color': feature('hair-color', 'Hair color · ombre', 'ai_hair_color', 'hair-color', 1, hairColor,
    ['Generic upload endpoint was independently verified live by the user; no feature suffix is needed.', 'Ombre: two colors, line offset −0.99 to 0.99; coloring_section only permits top. With palettes [dark brown, chosen color], a positive offset is intended to keep the chosen color lower; appearance is not live-verified.', 'JPG/PNG; documented size limits conflict (long side <1920 vs width <1920 / height <1080); check before live use.'],
    `${API}/file`, 'RunHairColorTaskV2 / RunHairColorTaskParams', 'User-provided verified live fact (2026-10-19): generic POST /s2s/v2.0/file'),
  ring: feature('ring', 'Ring · single', 'ring_vto', '2d-vto/ring', 1, (id, options) => ring(id, options),
    ['Requires one additional uploaded product photo in refFileIds.'], `${API}/file/2d-vto/ring`, 'RingRunTaskV2 / 2dVtoRunTaskV2'),
  'ring-stacked': feature('ring-stacked', 'Ring · stacked', 'ring_vto', '2d-vto/ring', 2, (id, options) => ring(id, options, true),
    ['Builder supports two uploaded product photos in refFileIds.'], `${API}/file/2d-vto/ring`, 'RingRunTaskV2 / 2dVtoRunTaskV2'),
  nail: feature('nail', 'Nail color · per finger', 'ai_nail_vto', 'nail-vto', 1, nail,
    ['One back-of-hand photo; JPG/PNG, long side ≤2048, short side ≥256, ≤10 MB. UI little maps to API pinky.'], `${API}/file`, 'NailVtoTaskRequest / NailVtoNailPolishColorEffect'),
  makeup: feature('makeup', 'Makeup · skin smoothing / lip color', 'makeup_vto', 'makeup-vto', 1, makeup,
    ['Default is skin_smooth; lipColor selects a matte full lip_color effect with the documented original lip shape.'], `${API}/file`, 'schema_1548 / SkinSmoothEffect / LipColorEffect'),
  'hairstyle-preset': feature('hairstyle-preset', 'Hairstyle · preset V2.0', 'ai_hairstyle', 'hair-style', 1, withTemplate,
    ['Requires templateId from the documented template API. V2.1 is a different endpoint and costs 2 units.'], `${API}/file`, 'schema_1278 / RunWithSingleTemplateAndSrcUrl'),
  'hairstyle-custom': feature('hairstyle-custom', 'Hairstyle · custom V2.0', 'ai_hairstyle', 'hair-transfer', 2, withReference,
    ['Requires an additional uploaded reference photo in refFileId.'], `${API}/file`, 'schema_1276 / BasicRunTaskV2WithRequiredRef'),
  beard: feature('beard', 'Beard style', 'ai_beard_style', 'beard-style', 2, withTemplate,
    ['Requires templateId from the documented template API. srcFileUrl can chain a previous task result instead of a source file ID.'], `${API}/file`, 'schema_1103 / RunWithSingleTemplateAndSrcUrl'),
  'hair-type': feature('hair-type', 'Hair type detection', 'ai_hair_type_detection', 'hair-type-detection', 2, threeAngles,
    ['Requires three uploaded photo IDs in srcFileIds, in documented order: front, right, left.'], `${API}/file`, 'BasicFaceAttrReqFaceThreeAngleWithSrcFileIds'),
  'hair-density': feature('hair-density', 'Hair density detection', 'ai_hair_density_detection', 'hair-density-detection', 1, source,
    [], `${API}/file`, 'BasicRunTaskV2'),
  'hair-frizziness': feature('hair-frizziness', 'Hair frizziness detection', 'ai_hair_frizziness_detection', 'hair-frizziness-detection', 2, threeAngles,
    ['Requires three uploaded photo IDs in srcFileIds, in documented order: front, right, left. A single P1 input is not documented.'], `${API}/file`, 'BasicFaceAttrReqFaceThreeAngleWithSrcFileIds'),
  'facial-color-tones': feature('facial-color-tones', 'Facial color tones', 'ai_skin_tone_analysis', 'skin-tone-analysis', 20, facialColorTones,
    [], `${API}/file`, 'RunSkinToneAnalysisTaskV2'),
  'clothes-v2': feature('clothes-v2', 'Clothes V2', 'ai_clothes', 'cloth', 2, (id, options) => clothes(id, options, 2),
    ['Requires templateId, or refFileId plus garmentCategory.'], `${API}/file`, 'RunClothsTaskV2'),
  'clothes-v3': feature('clothes-v3', 'Clothes V3', 'ai_clothes', 'cloth-v3', 2, (id, options) => clothes(id, options, 3),
    ['Requires refFileId and garmentCategory.'], `${API}/file`, 'RunClothV3Task'),
  'clothes-v4': feature('clothes-v4', 'Clothes V4', 'ai_clothes', 'cloth-v4', null, (id, options) => clothes(id, options, 4),
    ['TODO after registration: verify unit cost; absent from Unit Consumption table.', 'Requires refFileId and garmentCategory.'], `${API}/file`, 'RunClothV4Task'),
});

export function getFeature(id) {
  if (typeof id !== 'string' || !Object.hasOwn(FEATURES, id)) throw new Error('Unknown feature');
  return FEATURES[id];
}

export function publicFeatures() {
  return Object.values(FEATURES).map(({ buildRequest, ...metadata }) => metadata);
}
