// The desktop shell's model-import surface (apps/desktop/preload.cjs window.oipModel): a picked file's path, and a USD
// root layer read with the layers and images beside it. Absent in a browser, which can only read what it was handed.

export interface OipModelApi {
  /** the picked file's path on disk, or '' for one that has none */
  pathOf(file: File): string
  /** a .usd / .usda / .usdc root layer and the USD layers and images under its folder, keyed by path from there */
  readUsd(path: string): Promise<{ name: string; bytes: Uint8Array; files?: { path: string; bytes: Uint8Array }[]; root?: string } | { error: string }>
}

declare global {
  interface Window {
    oipModel?: OipModelApi
  }
}

/** The desktop model API, or null outside the Electron shell (the browser). */
export function getOipModelApi(): OipModelApi | null {
  return typeof window !== 'undefined' && window.oipModel ? window.oipModel : null
}
