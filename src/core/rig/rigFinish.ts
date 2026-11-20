// A rig link's finish as one instance shows it. A link may hand the choice to an enum param (`finishParam`, a
// platform's "Deck surface"). Everything that draws a rig reads the result through here, so a link's look has one
// rule. This covers the look only: no body, collider or snap depends on a finish.
import type { Finish, ParamSchema } from '../parts/partApi'
import { RIG_FINISHES } from '../parts/partValidateRig'
import type { PartPackage, RigLink } from '../parts/partPackage'

type RigGeo = Extract<PartPackage['geometry'], { kind: 'rig' }>

/** The finish `link` shows for these params: its `finishParam`'s value when that is a finish (the param's default
 *  when unset), else its own `finish`. */
export function linkFinish(link: RigLink, params: Readonly<Record<string, unknown>>, specs: ParamSchema | undefined): Finish | undefined {
  if (link.finishParam === undefined) return link.finish
  const v = params[link.finishParam] ?? specs?.[link.finishParam]?.default
  return typeof v === 'string' && RIG_FINISHES.includes(v as Finish) ? (v as Finish) : link.finish
}

/** `geo` with every `finishParam` link's `finish` resolved for these params. The same object when no link chooses
 *  (every rig but the few that do), so callers can compare by identity. */
export function resolveLinkFinishes(geo: RigGeo, params: Readonly<Record<string, unknown>>, specs: ParamSchema | undefined): RigGeo {
  if (!geo.links.some((l) => l.finishParam !== undefined)) return geo
  return {
    ...geo,
    links: geo.links.map((l) => {
      if (l.finishParam === undefined) return l
      const finish = linkFinish(l, params, specs)
      return finish === l.finish ? l : { ...l, finish }
    }),
  }
}

/** A short key of the chosen finishes ('' when no link chooses), so a visual can tell that a choice changed and
 *  rebuild: a finish is a material, picked when the visual is built. */
export function linkFinishKey(geo: RigGeo, params: Readonly<Record<string, unknown>>, specs: ParamSchema | undefined): string {
  let key = ''
  for (const l of geo.links) if (l.finishParam !== undefined) key += `${l.name}=${linkFinish(l, params, specs) ?? ''};`
  return key
}
