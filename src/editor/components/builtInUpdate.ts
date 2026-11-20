// The one question the app asks about a built-in part it has updated since this project made its own version of it
// (core/builtInVersion.ts): which version should the project use? The catalog's "Updated" badge and the Inspector
// both ask it, with these words and these two answers, so they can't disagree.

import type { EditorController } from '../controller'

/** what has happened, in one sentence. `edited`: the project has changed its copy (editedSinceCopied) */
export function builtInUpdatedText(name: string, edited: boolean): string {
  return edited
    ? `The app's ${name} has been updated since this project made its own version of it. This project still uses its own.`
    : `The app's ${name} has been updated since this project copied it. This project still uses the version it has.`
}

export interface BuiltInUpdateChoice {
  label: string
  title: string
  testid: string
  onClick: () => void
}

/** the two answers: take the app's new version (this project's changes go), or keep this project's (and stop asking) */
export function builtInUpdateChoices(controller: EditorController, packageId: string, name: string, edited: boolean): BuiltInUpdateChoice[] {
  const lost = edited ? " This project's changes to it are discarded." : ''
  return [
    {
      label: "Use the app's new version",
      title: `Replace this project's ${name} with the app's updated one.${lost}`,
      testid: 'builtin-update-use',
      onClick: () => {
        if (window.confirm(`Use the app's new ${name}?${lost} Every placed copy changes.`)) {
          controller.updateFromApp([packageId])
        }
      },
    },
    {
      label: "Keep this project's version",
      title: `Keep this project's ${name} as it is. The app asks again only if it updates ${name} again.`,
      testid: 'builtin-update-keep',
      onClick: () => controller.keepProjectVersion(packageId),
    },
  ]
}

/** the update prompt's headline (PartUpdatesNotice), for updates from any source */
export function updatesAvailableText(count: number): string {
  return count === 1 ? '1 part in this project has an update' : `${count} parts in this project have updates`
}

/** what Update all asks first: how many change, and by name which of them lose this project's own changes */
export function updateAllQuestion(names: readonly string[], editedNames: readonly string[]): string {
  const list = (xs: readonly string[]): string => xs.slice(0, 4).join(', ') + (xs.length > 4 ? ` and ${xs.length - 4} more` : '')
  const what = names.length === 1 ? `Update ${names[0]} to its newer version?` : `Update ${names.length} parts to their newer versions (${list(names)})?`
  const lost =
    editedNames.length === 0
      ? ''
      : editedNames.length === 1
        ? ` ${editedNames[0]} was changed in this project, and those changes are discarded.`
        : ` ${list(editedNames)} were changed in this project, and those changes are discarded.`
  return `${what}${lost} Every placed copy changes.`
}
