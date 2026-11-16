// Unit Load — a pallet and the cases on it as ONE product: the handling unit a warehouse moves, stores and tracks.
//
// It is a container. Parent a pallet and its cases under it in the scene tree and they are the load: membership is
// exactly its children, nothing is guessed from what happens to stand on the pallet. It selects and drags as one (a
// click on any case selects the load, a double-click drills in to the case), and it draws nothing of its own.
//
// Or file nothing under it and it stacks the standard load itself, COURSES of it (three by default, so a load dropped
// from the catalog is a full load, not an invisible empty container): a 48 x 40 in pallet under
// courses of 0.6 x 0.4 x 0.4 cases, two laid straight beside three turned, each course turned a half-turn on the one
// below. They are real cargo all the same (a truck lifts them, a sensor sees each case), just not a scene part per
// case, which is what makes a rack full of stock or a dock lane of loads cheap to author and to save. The origin is
// the pallet's underside, so it seats on a floor, a deck or a rack beam. Cargo filed under it always wins.
//
// What it carries are PRODUCT ATTRIBUTES (params flagged `attribute`): whether the load is stretch-wrapped and its
// load ID. At Run they are the load's marks, which machines on the line update and sensors read (a diffuse sensor
// set to "Only marked targets: wrapped" sees only wrapped loads), and the Inspector shows their live values.
//
// A wrapped load starts the run the way a stretch wrapper leaves one (the `unit` declaration): ONE rigid body, so it
// travels, is lifted by a truck and sits in a rack as a piece, and a sleeve of film round it, in the colour and
// opacity set here. An unwrapped one starts as loose pieces that happen to be filed together.

definePart({
  unit: {
    joinWhen: 'wrapped',
    dress: [{ id: 'film', material: 'film', when: 'wrapped', colorParam: 'filmColor', opacityParam: 'filmOpacity' }],
    // what it stacks itself out of: a project that places a load carries these parts too
    pieces: { pallet: 'oip.pallet', case: 'oip.box' },
  },
  params: {
    wrapped: { type: 'boolean', default: false, attribute: true, label: 'Stretch wrapped', desc: 'The load is stretch-wrapped: at Run it is one rigid body with film round it, and it carries the mark wrapped for anything downstream that checks. Off, its pieces start loose.' },
    loadId: { type: 'string', default: '', attribute: true, label: 'Load ID', desc: 'The label on the load (an SSCC, a licence plate). Carried as the mark loadId, so a scanner or a program can tell loads apart.' },
    courses: { type: 'number', default: 3, min: 0, max: 4, step: 1, label: 'Courses', group: 'Stack', desc: 'With no cargo filed under the load, it stacks this many courses of cases on a pallet itself (0.4 m each; three is a full load). 0 = the load is the pallet and cases filed under it.' },
    caseColor: { type: 'color', default: '#ffffff', label: 'Case color', group: 'Stack', desc: 'Tint of the cases it stacks itself. White leaves the cardboard untinted.' },
    filmColor: { type: 'color', default: '#dcecf2', label: 'Film color', group: 'Film', desc: 'Colour of the stretch film: clear film has a faint blue, and loads are also wrapped in white or black film to hide what is inside.' },
    filmOpacity: { type: 'number', unit: '%', default: 0.42, min: 0.1, max: 1, step: 0.01, label: 'Film opacity', group: 'Film', desc: 'How see-through the film is. Clear film shows the cases through it; white or black film is nearly opaque.' },
  },
  react() {
  },
})
