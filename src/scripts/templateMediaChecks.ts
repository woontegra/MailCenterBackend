import assert from 'node:assert/strict';
import {
  detectTemplateImageMime,
  validateTemplateMediaFile,
  TEMPLATE_MEDIA_MAX_BYTES,
} from '../utils/templateMediaValidation';

// Minimal PNG header
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

// Minimal JPEG SOI
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

assert.equal(detectTemplateImageMime(PNG), 'image/png');
assert.equal(detectTemplateImageMime(JPEG), 'image/jpeg');
assert.equal(detectTemplateImageMime(SVG), null);

const pngOk = validateTemplateMediaFile({ buffer: PNG, sizeBytes: PNG.length });
assert.equal(pngOk.ok, true);

const svgReject = validateTemplateMediaFile({ buffer: SVG, sizeBytes: SVG.length });
assert.equal(svgReject.ok, false);

const oversize = validateTemplateMediaFile({
  buffer: PNG,
  sizeBytes: TEMPLATE_MEDIA_MAX_BYTES + 1,
});
assert.equal(oversize.ok, false);
if (oversize.ok === false) {
  assert.match(oversize.error, /MB sınırını/);
}

console.log('templateMediaValidation checks passed');
