// A signing key for the gates only (e2e/verify-part-library.mjs, src/core/librarySignature.test.ts). Its private half
// is public on purpose: a dev build trusts it (editor/parts/partLibraries.ts, import.meta.env.DEV), a production build never
// does. The project's real key lives only in CI secrets (npm run library-key).
export const TEST_LIBRARY_KEY = {
  id: '203383cd7bf784b2',
  publicKey: '2iOUqCAxDyE61UDm+sOlaG2W+GWQHWQSMKF79c09hEY=',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIK+GHoj0+0n5wdVRLWyxrIaSmoFxwE25Q8TZecrMsenm\n-----END PRIVATE KEY-----\n',
}
