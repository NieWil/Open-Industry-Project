// The running surface's grip, shared by every conveyor part. The manifest names it as `conveyor.frictionParam`, and
// the host reads it when it builds the deck: the value is the friction against a standard carton, the figure a belt
// datasheet quotes. Defaults: a belt 0.59 and rollers 0.42, the grip a carton has on each surface kind that declares no param.

/** The `friction` param, with the surface's default grip against a carton. */
export function frictionParam(carton) {
  return {
    friction: { type: 'number', default: carton, min: 0, step: 0.01, label: 'Friction', desc: 'Grip between the running surface and a standard carton, the figure a belt datasheet quotes. A smooth PVC belt is about 0.4, a rough-top incline belt about 0.9 and a low-friction plastic modular belt about 0.2, made for product to slide while it accumulates. Bare steel rollers are about 0.4. Other cargo grips by its own friction against the same surface.' },
  }
}
