// Read a GLB's geometry extents without a renderer. The code is src/core/glbBox.ts, which the app's import_model
// agent tool uses too; measure-glb.mjs (`npm run inspect-glb`) and check-part.mjs read it through here.
export { apply, drawnElsewhere, emptyBox, fromTRS, growBox, ident, isEmpty, meshLinkBox, mul, nodeMatrix, parseGlb } from '../../src/core/glbBox.ts'
