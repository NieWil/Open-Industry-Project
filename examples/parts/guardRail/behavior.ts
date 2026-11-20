// Guard Rail — a structural safety railing. Demonstrates the array-links 'distribute' form: the posts
// auto-space evenly along the 'length' param (N = ceil(length/2.4)+1), and the two rails are length-parametric.
// The omit-post toggles drop an end post so two rails butt flush. No runtime logic — the params reshape the rig.

definePart({
  params: {
    length: { type: 'number', default: 4, min: 0.5, step: 0.1, label: 'Length (m)', handle: { kind: 'face', axis: 'x' }, desc: 'Rail run length along local +X. Posts re-space themselves to stay under 2.4 m apart. Drag the dot on either end face to resize in the viewport.' },
    color: { type: 'color', default: '#f2bd0f', label: 'Steel color', desc: 'Steel tint of the rails and posts.' },
    omitPostStart: { type: 'boolean', default: false, label: 'Omit start post', group: 'Posts', desc: 'Suppress the post at local -X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
    omitPostEnd: { type: 'boolean', default: false, label: 'Omit end post', group: 'Posts', desc: 'Suppress the post at local +X so a snapped neighbour draws the shared one instead. Snapping sets this for you.' },
  },
  react() {},
})
