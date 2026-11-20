// Pop-up Diverter — a guided pusher. A short bearing block holds two guide rods and the rod of a drive cylinder; all
// three are fixed to the blade and move with it as ONE stage, pushing it across the lane to deflect cargo onto a
// takeaway conveyor. The blade carries the collision box that shoves cargo (the hidden `blade` link, a child of
// partEnd: a hidden link hides what is drawn on it too, so the meshes ride the visible partEnd frame instead).
// Driven by an authored 'diverted' toggle / a hand Use, or by its tag while a PLC program drives it
// (ctx.tagDriven). The auto-vs-hand handoff follows output ownership, like a real panel.
//
// Demonstrates procedural geometry riding a rig joint (geometry() submeshes tagged `link`) and sized by a param. The
// block is the same for every stroke; what `divertDistance` sizes is what has to be as long as the stroke: the guide
// rods (retracted, they stand out behind the block by the stroke, tied by a bar that comes up against the block at
// full reach), the drive cylinder's barrel behind the block, and the stand under both. So the stroke is visible at
// rest. The joint limit stays at the 1.5 m maximum stroke: the behavior never drives past the param.
//
// Its finish is textures on code-built shapes: the rods and the cylinder sample a brushed-metal image triplanar (in
// object space, so the grain rides the moving rods instead of swimming), and the warning label is an image on a
// thin box, drawn by scripts/build-diverter-textures.mjs.
//
// Frame: local -Z is the push direction. The blade's face at rest is z = -1.103 and stays there for every stroke,
// so the conveyor-guard mount (snap `at`) never moves; the machine grows back from it along +Z.
//
// It stands on its own legs wherever it is mounted: `standHeight` is a host-resolved placement fact (rest:
// 'surfaceBelow'), the distance from the origin down to whatever is under it, which the host writes at drop and
// snap. So a diverter seated on a conveyor's guard grows its legs to the floor at any belt height, the same way a
// conveyor's own legs do.

let progress = 0 // 0 retracted .. 1 fully extended
let diverted = false
let lastDiverted // adopt the Inspector 'diverted' toggle whenever it changes

definePart({
  interactive: true,
  useParam: 'diverted', // the hand state is the param: the state a run starts from. The Inspector sets it; Use never writes it
  joints: ['ext3'],
  lamps: ['red', 'green'], // the control box's two lenses
  params: {
    diverted: { type: 'boolean', default: false, label: 'Diverted', group: 'Start state', desc: 'Push the blade across the lane to deflect cargo. This is the state it starts in; Use cycles it by hand. While a program drives the tag below, that program owns it instead.' },
    divertTime: { type: 'number', default: 0.25, min: 0.05, max: 2, step: 0.01, label: 'Divert time (s)', desc: 'How long the blade takes to travel the full stroke, out or back. Too slow and cargo passes before the blade arrives.' },
    divertDistance: { type: 'number', default: 0.75, min: 0.1, max: 1.5, step: 0.05, label: 'Divert distance (m)', desc: 'How far the blade travels across the lane. Size it so the blade pushes cargo clear of the running surface rather than leaving it straddling the edge. The guide rods, the cylinder and the stand are built for this stroke, so a longer one makes a longer machine.' },
    // the default is the stand a free-standing drop gets: the origin 0.3847 above the floor, the footprint's `bottom`
    standHeight: { type: 'number', default: 0.3847, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'From the part origin, 0.2 m below the belt surface it is mounted against, down to whatever the stand stands on. Set automatically when the diverter is dropped or snapped, so its legs reach the floor at any belt height.' },
    // autoWhenDriven: this tag COMMANDS the pusher, so a program driving it owns the device — the pilot prompt
    // shows "In auto - PLC controlled" instead of a dead "Use".
    tag: { type: 'tag', dir: 'in', stType: 'BOOL', autoWhenDriven: true, default: '', label: 'Extend tag (true extends the pusher)', group: 'Comms', desc: 'Extend the pusher from the program. While a program drives this tag it OWNS the diverter, so a hand Use in pilot mode is refused with "In auto - PLC controlled".' },
  },
  geometry(g, p) {
    const S = typeof p.divertDistance === 'number' ? Math.min(1.5, Math.max(0.1, p.divertDistance)) : 0.75
    // along Z: the blade (rubber face, plate, the boss the rods mount to), the glands, the bearing block, then the
    // cylinder barrel behind it
    const BLADE_FRONT = -1.103, RUBBER = 0.012, PLATE = 0.025, BOSS = 0.035, GLAND = 0.04, BLOCK = 0.42
    const bladeBack = BLADE_FRONT + RUBBER + PLATE + BOSS
    const front = bladeBack + GLAND // the block's front face, where the rods leave it
    const blockRear = front + BLOCK
    const TIE = 0.03 // the tie bar's depth: at full reach it sits against the rear glands
    const REAR_GLAND = 0.025 // a shallower gland round each guide rod where it leaves the block's rear face
    const glandRear = blockRear + REAR_GLAND
    const rodTail = glandRear + S + TIE // the guide rods' back end, at rest
    const barrelEnd = blockRear + S + 0.04 // the barrel holds the piston's whole travel
    const CAP = 0.03
    // vertically: a compact body round the rods (the rods at cargo height, the hood just over them), carried on a
    // steel stand down to whatever is under it (`standHeight` below the origin)
    const FLOOR = -(typeof p.standHeight === 'number' && p.standHeight > 0 ? p.standHeight : 0.3847), PLATE_T = 0.012
    const base = 0.24 // the block's underside, just under the blade's bottom edge
    const ROD_Y = 0.446, ROD_X = 0.13, GUIDE_R = 0.025 // the guide rods
    const DRIVE_Y = 0.33, DRIVE_R = 0.016, BARREL_R = 0.045, CAP_W = 0.12 // the drive cylinder, below the tie bar's path
    const BLADE_Y = 0.447, BLADE_W = 0.47, BLADE_H = 0.395
    const HW = 0.31, CAB_HW = 0.29, CAB_TOP = 0.5, TOP = 0.66

    const into = (desc, origin) => g.transform(desc, { translate: [-origin[0], -origin[1], -origin[2]] })
    const tube = (x, y, z0, length, r, segments) => g.lathe([[0, 0], [r, 0], [r, length], [0, length]], { axis: 'z', center: [x, y, z0], segments: segments || 20 })

    // the stand: four square-tube legs on foot plates under a top frame that runs the machine's length, a mounting
    // plate under the block, a saddle under the barrel's end, and a rail round the legs low down
    const LEG = 0.05, LEG_X = 0.27, FOOT = 0.12, FOOT_T = 0.012, RAIL = 0.04, RAIL_Y = FLOOR + 0.12
    const legZ = [front + 0.07, barrelEnd - 0.03]
    const frameTop = base - PLATE_T, frameY = frameTop - RAIL / 2
    const legH = frameTop - RAIL - FLOOR - FOOT_T
    const span = legZ[1] - legZ[0], spanMid = (legZ[0] + legZ[1]) / 2
    const standParts = [g.box([2 * HW, PLATE_T, BLOCK], [0, base - PLATE_T / 2, front + BLOCK / 2])]
    for (const x of [-LEG_X, LEG_X]) {
      for (const z of legZ) {
        standParts.push(g.box([LEG, legH, LEG], [x, FLOOR + FOOT_T + legH / 2, z]))
        standParts.push(g.bevelBox([FOOT, FOOT_T, FOOT], [x, FLOOR + FOOT_T / 2, z], 0.003, ['y-']))
      }
      standParts.push(g.box([RAIL, RAIL, span + LEG], [x, frameY, spanMid]))
      standParts.push(g.box([RAIL, RAIL, span - LEG], [x, RAIL_Y, spanMid]))
    }
    for (const z of legZ) {
      standParts.push(g.box([2 * LEG_X - LEG, RAIL, RAIL], [0, frameY, z]))
      standParts.push(g.box([2 * LEG_X - LEG, RAIL, RAIL], [0, RAIL_Y, z]))
    }
    const saddleH = DRIVE_Y - BARREL_R - frameTop
    standParts.push(g.box([0.12, saddleH, 0.05], [0, frameTop + saddleH / 2, legZ[1]]))
    const stand = g.merge(...standParts)

    // the bearing block: a dark cabinet, stopping 1 cm short of the hood's rear face so the two never share a plane
    const cabinet = g.box([2 * CAB_HW, CAB_TOP - base, BLOCK - 0.01], [0, (base + CAB_TOP) / 2, front + BLOCK / 2 - 0.005])
    // The hood, drawn as its SIDE profile and run across the width: a rounded nose just behind the rod face, a
    // rounded back, and a diagonal cut-away from the nose down toward the stand that leaves the cabinet showing
    // under the rods. In the profile's (z, y): along the bottom, up the back, over the top, down the nose.
    const NOSE_R = 0.06, BACK_R = 0.07, LOW = base + 0.06
    const nose = front + 0.06
    const cut = nose + Math.min(0.2, 0.5 * (blockRear - BACK_R - nose)) // where the diagonal meets the hood's bottom edge
    const zy = [[cut, LOW], [blockRear, LOW]]
    for (const q of g.arc([blockRear - BACK_R, TOP - BACK_R, 0], BACK_R, 0, Math.PI / 2, 6)) zy.push([q[0], q[1]])
    for (const q of g.arc([nose + NOSE_R, TOP - NOSE_R, 0], NOSE_R, Math.PI / 2, Math.PI, 6)) zy.push([q[0], q[1]])
    zy.push([nose, CAB_TOP])
    // an outline across X is (y, z): the swap mirrors it, so reverse it to keep it counter-clockwise
    const hood = g.extrude(zy.map(([z, y]) => [y, z]).reverse(), -HW, HW, { axis: 'x', bevel: 0.012 })
    // a gland on the block's face round each rod
    const glands = g.merge(
      g.bevelBox([0.09, 0.09, GLAND], [-ROD_X, ROD_Y, front - GLAND / 2], 0.006, ['z+']),
      g.bevelBox([0.09, 0.09, GLAND], [ROD_X, ROD_Y, front - GLAND / 2], 0.006, ['z+']),
      g.bevelBox([0.07, 0.07, GLAND], [0, DRIVE_Y, front - GLAND / 2], 0.006, ['z+']),
      // and on the rear face, so the rods pass through a part rather than into the hood's bare panel; at full reach
      // the tie bar stops against these
      g.bevelBox([0.09, 0.09, REAR_GLAND], [-ROD_X, ROD_Y, blockRear + REAR_GLAND / 2], 0.006, ['z-']),
      g.bevelBox([0.09, 0.09, REAR_GLAND], [ROD_X, ROD_Y, blockRear + REAR_GLAND / 2], 0.006, ['z-']),
    )
    // the drive cylinder: a barrel between two square end caps, held together by four tie rods with a nut at the
    // back, and an air port on the side of each cap. The front cap is bolted to the block's rear face.
    const CAP_L = 0.04, NUT = 0.008, machineRear = barrelEnd + CAP // the nuts end the machine
    const capFront = blockRear + CAP_L / 2, capRear = machineRear - NUT - CAP_L / 2
    const TIE_R = 0.006, TIE_OFF = CAP_W / 2 - 0.014
    const cylinder = [
      tube(0, DRIVE_Y, blockRear + CAP_L, machineRear - NUT - blockRear - 2 * CAP_L, BARREL_R, 24),
      g.bevelBox([CAP_W, CAP_W, CAP_L], [0, DRIVE_Y, capFront], 0.006, ['z-']),
      g.bevelBox([CAP_W, CAP_W, CAP_L], [0, DRIVE_Y, capRear], 0.006),
    ]
    for (const tx of [-TIE_OFF, TIE_OFF]) {
      for (const ty of [-TIE_OFF, TIE_OFF]) {
        cylinder.push(tube(tx, DRIVE_Y + ty, blockRear, machineRear - blockRear - 0.002, TIE_R, 8))
        cylinder.push(g.lathe([[0, 0], [0.011, 0], [0.011, NUT], [0, NUT]], { axis: 'z', center: [tx, DRIVE_Y + ty, machineRear - NUT], segments: 6, smooth: false }))
      }
    }
    // an air port on the -X side of each cap: a hex body and a push-in fitting, the hose starting at its tip
    const PORT_X = -CAP_W / 2 - 0.022
    const port = (z) => [
      g.lathe([[0, 0], [0.012, 0], [0.012, 0.01], [0, 0.01]], { axis: 'x', center: [-CAP_W / 2 - 0.01, DRIVE_Y, z], segments: 6, smooth: false }),
      g.lathe([[0, 0], [0.008, 0], [0.008, 0.012], [0, 0.012]], { axis: 'x', center: [PORT_X, DRIVE_Y, z], segments: 12 }),
    ]
    cylinder.push(...port(capFront), ...port(capRear))
    const barrel = g.merge(...cylinder)
    // the valve that switches the cylinder, on the block's rear face beside it, and its two hoses: one from the front
    // port straight across, one from the rear port along the barrel's side and round into the valve's back
    const VALVE = [0.06, 0.05, 0.05], VALVE_X = -0.21
    const valve = g.bevelBox(VALVE, [VALVE_X, DRIVE_Y, blockRear + VALVE[2] / 2], 0.004, ['z-'])
    const HOSE_R = 0.0055, HOSE_BEND = 0.05
    const hoseProfile = []
    // [up, width], up first: the other order turns the tube inside out
    for (let i = 0; i < 10; i++) hoseProfile.push([HOSE_R * Math.cos((2 * Math.PI * i) / 10), HOSE_R * Math.sin((2 * Math.PI * i) / 10)])
    // each hose starts inside its port's fitting (which runs +X from PORT_X) and ends inside the valve, behind a
    // fitting of the same size on the valve's face, so neither end shows a gap or an open tube end
    const SEAT = 0.004
    const valveFace = VALVE_X + VALVE[0] / 2, valveBack = blockRear + VALVE[2]
    const valveFittings = g.merge(
      g.lathe([[0, 0], [0.008, 0], [0.008, 0.012], [0, 0.012]], { axis: 'x', center: [valveFace, DRIVE_Y, capFront], segments: 12 }),
      g.lathe([[0, 0], [0.008, 0], [0.008, 0.012], [0, 0.012]], { axis: 'z', center: [VALVE_X, DRIVE_Y, valveBack], segments: 12 }),
    )
    const hoseFront = g.sweep(hoseProfile, [[PORT_X + SEAT, DRIVE_Y, capFront], [valveFace - SEAT, DRIVE_Y, capFront]])
    // the rear hose runs out along -X, bends a quarter turn round a centre inside the corner, and runs along -Z to
    // the valve's back face
    const bendC = [VALVE_X + HOSE_BEND, capRear - HOSE_BEND]
    const rearPath = [[PORT_X + SEAT, DRIVE_Y, capRear]]
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI / 2 + (Math.PI / 2) * (i / 8)
      rearPath.push([bendC[0] + HOSE_BEND * Math.cos(a), DRIVE_Y, bendC[1] + HOSE_BEND * Math.sin(a)])
    }
    rearPath.push([VALVE_X, DRIVE_Y, valveBack - SEAT])
    const hoseRear = g.sweep(hoseProfile, rearPath)
    // the control box on the block's side (its back is where the rods come out): two buttons and the two lenses
    const PANEL_Y = 0.44, PANEL_Z = blockRear - 0.11, PANEL_D = 0.03, face = HW + PANEL_D
    const panel = g.bevelBox([PANEL_D + 0.01, 0.22, 0.18], [HW + PANEL_D / 2 - 0.005, PANEL_Y, PANEL_Z], 0.006, ['x-'])
    const knob = (y, z, profile) => g.lathe(profile, { axis: 'x', center: [face, y, z], segments: 16 })
    const BUTTON = [[0, 0], [0.024, 0], [0.024, 0.015], [0, 0.015]]
    const LENS = [[0, 0], [0.02, 0], [0.02, 0.01], [0.014, 0.018], [0, 0.02]]
    // a steel bezel round each button and lens, and a visor over each lens so it reads in a bright hall
    const ring = (y, z, r) => g.lathe([[r, 0], [r + 0.008, 0], [r + 0.008, 0.005], [r, 0.005], [r, 0]], { axis: 'x', center: [face, y, z], segments: 16 })
    const bezels = g.merge(
      ring(0.48, PANEL_Z + 0.045, 0.024), ring(0.4, PANEL_Z + 0.045, 0.024),
      ring(0.48, PANEL_Z - 0.045, 0.02), ring(0.4, PANEL_Z - 0.045, 0.02),
    )
    const visors = g.merge(
      g.box([0.024, 0.005, 0.05], [face + 0.012, 0.48 + 0.028, PANEL_Z - 0.045]),
      g.box([0.024, 0.005, 0.05], [face + 0.012, 0.4 + 0.028, PANEL_Z - 0.045]),
    )

    // a louvred vent on the block's other side: a dark back plate with slats across it
    const VENT_Z = blockRear - 0.13, VENT_Y = 0.52
    const ventBack = g.box([0.006, 0.1, 0.16], [-HW - 0.002, VENT_Y, VENT_Z])
    const slats = []
    for (let i = 0; i < 4; i++) slats.push(g.box([0.012, 0.012, 0.15], [-HW - 0.006, VENT_Y - 0.0375 + i * 0.025, VENT_Z]))
    // The warning label: a thin box whose outward face carries a whole texture (the builder maps every box face 0..1;
    // scripts/build-diverter-textures.mjs draws it), on the back face above the rods' path (the tie bar comes up to
    // y 0.48 at full reach).
    const label = g.box([0.1, 0.1, 0.003], [0, 0.538, blockRear + 0.0015])
    // a cable gland under the control box, its cable bending down and into the cabinet below the hood
    const glandY = PANEL_Y - 0.11, cableX = HW + PANEL_D / 2
    const cableGland = g.lathe([[0, 0], [0.011, 0], [0.011, 0.012], [0.008, 0.02], [0, 0.02]], { axis: 'y', center: [cableX, glandY - 0.02, PANEL_Z], segments: 6, smooth: false })
    const cablePath = g.fillet([[cableX, glandY - 0.02, PANEL_Z], [cableX, base + 0.025, PANEL_Z], [CAB_HW - 0.01, base + 0.025, PANEL_Z]], 0.025)
    const cable = g.sweep(hoseProfile, cablePath)

    // hex bolt heads: two anchor bolts through each foot plate, four on the face of each guide gland
    const hex = (center, axis) => g.lathe([[0, 0], [0.011, 0], [0.011, 0.007], [0, 0.007]], { axis, center, segments: 6, smooth: false })
    const bolts = []
    for (const x of [-LEG_X, LEG_X]) for (const z of legZ) for (const dz of [-0.035, 0.035]) bolts.push(hex([x, FLOOR + FOOT_T, z + dz], 'y'))
    for (const gx of [-ROD_X, ROD_X]) for (const bx of [-0.035, 0.035]) for (const by of [-0.035, 0.035]) bolts.push(hex([gx + bx, ROD_Y + by, front - GLAND - 0.007], 'z'))
    // a rubber wiper ring where each rod leaves its gland
    const wiper = (x, y, r) => g.lathe([[r, 0], [r + 0.008, 0], [r + 0.008, 0.006], [r, 0.006], [r, 0]], { axis: 'z', center: [x, y, front - GLAND - 0.006], segments: 20 })
    const rearWiper = (x) => g.lathe([[GUIDE_R, 0], [GUIDE_R + 0.008, 0], [GUIDE_R + 0.008, 0.006], [GUIDE_R, 0.006], [GUIDE_R, 0]], { axis: 'z', center: [x, ROD_Y, glandRear], segments: 20 })
    const wipers = g.merge(wiper(-ROD_X, ROD_Y, GUIDE_R), wiper(ROD_X, ROD_Y, GUIDE_R), wiper(0, DRIVE_Y, DRIVE_R), rearWiper(-ROD_X), rearWiper(ROD_X))

    // the moving stage, drawn in partEnd's frame: the blade (rubber face, plate, a boss across the guide rods with a
    // rib up and down from each, a boss on the drive rod), the two guide rods with the tie bar across their back
    // ends, and the drive rod, whose back end stays inside the barrel at rest and inside the block at full reach
    const S3 = [0, BLADE_Y, -0.853]
    const zPlate = BLADE_FRONT + RUBBER, zBoss = zPlate + PLATE
    const rubber = g.box([BLADE_W - 0.02, BLADE_H - 0.02, RUBBER], [0, BLADE_Y, BLADE_FRONT + RUBBER / 2])
    const plate = g.bevelBox([BLADE_W, BLADE_H, PLATE], [0, BLADE_Y, zPlate + PLATE / 2], 0.008, ['z-'])
    const fittings = g.merge(
      g.bevelBox([2 * ROD_X + 0.1, 0.08, BOSS], [0, ROD_Y, zBoss + BOSS / 2], 0.006, ['z-']),
      g.bevelBox([0.03, BLADE_H - 0.06, BOSS * 0.8], [-ROD_X, BLADE_Y, zBoss + BOSS * 0.4], 0.004, ['z-']),
      g.bevelBox([0.03, BLADE_H - 0.06, BOSS * 0.8], [ROD_X, BLADE_Y, zBoss + BOSS * 0.4], 0.004, ['z-']),
      g.bevelBox([0.07, 0.07, BOSS], [0, DRIVE_Y, zBoss + BOSS / 2], 0.006, ['z-']),
      g.bevelBox([2 * ROD_X + 0.1, 0.07, TIE], [0, ROD_Y, rodTail - TIE / 2], 0.006),
    )
    const rods = g.merge(
      tube(-ROD_X, ROD_Y, bladeBack, rodTail - TIE - bladeBack, GUIDE_R),
      tube(ROD_X, ROD_Y, bladeBack, rodTail - TIE - bladeBack, GUIDE_R),
      tube(0, DRIVE_Y, bladeBack, blockRear + S - 0.02 - bladeBack, DRIVE_R, 16),
    )

    return [
      { desc: g.merge(stand, bezels), material: 'frame' },
      { desc: g.merge(cabinet, panel, visors, ventBack, valve, wipers, cableGland, cable), material: 'cabinet' },
      { desc: g.merge(hood, glands, ...slats), material: 'hood' },
      { desc: g.merge(barrel, valveFittings, ...bolts), material: 'barrel' },
      { desc: g.merge(hoseFront, hoseRear), material: 'hose' },
      { desc: label, material: 'label' },
      { desc: g.merge(knob(0.48, PANEL_Z + 0.045, BUTTON), knob(0.4, PANEL_Z + 0.045, BUTTON)), material: 'button' },
      { desc: knob(0.48, PANEL_Z - 0.045, LENS), material: 'lampRed', lamps: [{ name: 'red', emissive: [0.74902, 0.05098, 0.05098] }] },
      { desc: knob(0.4, PANEL_Z - 0.045, LENS), material: 'lampGreen', lamps: [{ name: 'green', emissive: [0, 1, 0.28235] }] },
      { desc: into(rods, S3), material: 'rod', link: 'partEnd' },
      { desc: into(plate, S3), material: 'hood', link: 'partEnd' },
      { desc: into(fittings, S3), material: 'frame', link: 'partEnd' },
      { desc: into(rubber, S3), material: 'rubber', link: 'partEnd' },
    ]
  },
  step(ctx) {
    // Signal precedence, modelled on a real panel: (1) the tag, while an attached program actually drives it
    // (ctx.tagDriven); (2) otherwise the hand signal — the 'diverted' param or a pilot Use.
    if (ctx.params.diverted !== lastDiverted) { diverted = ctx.params.diverted; lastDiverted = ctx.params.diverted }
    if (ctx.used()) diverted = !diverted
    // auto wins by overwriting the hand latch: a press while owned is undone the same tick, and when ownership
    // releases (program detach) the pusher holds its last commanded state.
    if (ctx.tagDriven(ctx.params.tag)) diverted = ctx.readTag(ctx.params.tag)
    // the hand latch AFTER the auto gate — what the device is really doing, for the Inspector readout
    ctx.report('diverted', diverted)
    const want = diverted ? 1 : 0
    const step = ctx.dt / Math.max(ctx.params.divertTime, 0.01)
    progress = ctx.approach(progress, want, step)
    const reach = ctx.params.divertDistance * progress
    ctx.joints.ext3 = reach
    // Panel indicators, read off the HOME end-of-stroke the way a real pusher's reed switches are: green while
    // the blade is home and the lane is clear, red the moment it leaves — held through the whole travel, out
    // and back, not just at full extension. Lighting green on extend and never driving red at
    // all would leave one lens permanently dead; both lenses carry a state here.
    const home = progress <= 1e-4
    ctx.lamps.green = home
    ctx.lamps.red = !home
  },
})
