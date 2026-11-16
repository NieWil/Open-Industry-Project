// Pallet — authored pallet cargo. Demonstrates the cargo geometry kind: the package geometry declares
// { kind: 'cargo', cargoKind: 'pallet' } and the host builds the part as one dynamic physics body, a four-way block
// pallet at the footprint its `size` picks (core/pallet.ts), rendered through the instanced cargo batch.
// Passive payload: react() is empty.

definePart({
  params: {
    size: {
      type: 'enum', default: '1219x1016', label: 'Size',
      desc: 'Footprint, from the six of ISO 6780; every size is 135 mm tall. The built-in AGV\'s forks enter the long face of every size, and the short face of the three square sizes too, above the bottom runners.',
      options: [
        { value: '1219x1016', label: '48 x 40 in (1219 x 1016 mm)' },
        { value: '1200x800', label: '1200 x 800 mm' },
        { value: '1200x1000', label: '1200 x 1000 mm' },
        { value: '1165x1165', label: '1165 x 1165 mm' },
        { value: '1100x1100', label: '1100 x 1100 mm' },
        { value: '1067x1067', label: '1067 x 1067 mm' },
      ],
    },
    mass: { type: 'number', default: 20, min: 5, max: 100, step: 1, label: 'Mass (kg)', desc: 'Physical mass of the pallet itself, before anything is stacked on it.' },
    // the colour is a tint over the pallet wood texture
    color: { type: 'color', default: '#ffffff', label: 'Color', desc: 'Tint over the pallet wood texture. White leaves it untinted.' },
  },
  react() {
  },
})
