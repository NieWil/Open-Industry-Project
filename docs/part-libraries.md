# Part libraries

Parts published outside the app: the project's own libraries, and a listed library of parts other people publish.
A submission is a pull request, reviewed in GitHub and built by CI. The project hosts its own copy of each accepted
part and signs the index.

## The pieces

### In the app

- **Index format and statuses:** [src/core/parts/partLibrary.ts](../src/core/parts/partLibrary.ts). `validateLibraryIndex`
  treats an index as untrusted: every file it names must be a `.oippart` path inside the library. `offeredVersion`
  is the newest version this build's SDK level runs ([part-sources.md](part-sources.md), "The Part SDK level").
  `libraryStatus` gives the four statuses from the listed fingerprint, so a listing needs no download.
  `checkLibraryDownload` requires a file to hash to its listed SHA-256 and build into its listed fingerprint.
- **Fetching and installing:** [src/editor/parts/partLibraries.ts](../src/editor/parts/partLibraries.ts).
- **Which libraries are read:** [src/editor/parts/partLibraryUrls.ts](../src/editor/parts/partLibraryUrls.ts). `?library=<index
  url>` alone for a session. Otherwise the official libraries left on, then the viewer's own. The official ones are
  `OFFICIAL_PART_LIBRARIES`, compiled into the build, so the app fetches no list and starts with no request to the
  bucket. Page loads, test runs and offline starts do not depend on reaching it. The list holds Containers and
  Community. Structure is left out because it repeats parts the app ships. Settings > Preferences > Part libraries
  switches an official library off and adds or removes the viewer's own. A library is read before it is added, so a
  wrong address or a host without CORS is reported there.
- **Updates in the Parts dock:** [libraryUpdates.ts](../src/editor/parts/libraryUpdates.ts). A project that holds a part
  from a library (recorded `origin.library`, or a copy of a built-in the app no longer ships) reads its libraries
  once, after the scene's first paint, and downloads and checks each newer version. That part's card then carries the
  same "Update" badge an app or shelf update does, and the updates notice counts it ([part-sources.md](part-sources.md)).
  A project with no library part makes no request, and a library that cannot be reached says nothing. Get parts hands
  the listings it reads to the same place, so the cards follow what that window shows.
- **Get parts:** [GetPartsWindow.tsx](../src/editor/components/GetPartsWindow.tsx), opened from the Parts dock's Get
  parts button or File > Get Parts…. Libraries are listed down the side and their parts as cards. A card shows the
  part's description and what it is to the machines around it (rolls, forks can pick it up, carries a stack), read
  from the part itself rather than the publisher's text. Each listed part is downloaded and checked when the window
  opens. Add to project copies it into the project's parts (`origin.library`) without placing it. Update opens the
  part change dialog, and Update all takes every newer version after one confirmation. A listed part names its
  publisher, linked to their GitHub account. More from <publisher> filters the library to their parts. Add a library
  adds one by the address of its index.json, with the same check as Settings (`addLibrary`). Under "Your parts",
  Publish a part opens Publish to Part Library for the selected part, the project's only part of its own, or a list
  to choose from.
- **Credit:** a copy added from a library keeps who made it (`PartPackage.credit`, core/parts/partPackage.ts
  `PartCredit`): the listed publisher and their GitHub page, the Open Industry Project for its own libraries, or only
  the library's name. The app writes it from the listing. It is kept through edits and Save as New Part and travels
  in exported projects, rooms and part files, since CC BY 4.0 requires attribution. It is not part of what the part
  is (`NOT_THE_PART`), so it never makes a copy read as edited. The Inspector shows it under the part's name, and the
  Parts dock card in its tooltip ([partCredit.ts](../src/editor/parts/partCredit.ts)). A link is followed only to a GitHub
  page or the project's site. Credit is Part SDK level 4.
- **Agent tools:** [libraryTools.ts](../src/editor/agent/libraryTools.ts), `list_library_parts` and
  `install_library_part` ([agent-tools.md](agent-tools.md)). A listing's names and descriptions reach the agent under
  `publisherText`.
- **Moved built-ins:** in a first-party library, a copy recorded as the app's built-in (`origin.app`) reads as made
  from the library, and so does a built-in the document places but has not copied yet. First-party means an `oip.*`
  id that carries the project's signature, from any host, or one served over https from `parts.openindustryproject.org`
  (`FIRST_PARTY_LIBRARY_HOSTS`, for an unsigned index on that host; a dev build adds 127.0.0.1 for the gate). The id
  alone is not enough, because anyone can host an index named `oip.*`, and its parts would then read as updates to the
  built-ins.
- **Signing:** [src/core/librarySignature.ts](../src/core/librarySignature.ts). The project's Ed25519 key signs each
  index it publishes, over the index without its `signature` field in canonical JSON. The index names each part file
  by its SHA-256, so the signature covers every byte a part brings. The public keys are in
  [librarySigningKeys.ts](../src/core/librarySigningKeys.ts), written by `npm run library-key`, which puts the private
  key in CI secrets and nowhere else. `readLibrary` refuses an index that a trusted key signed and that has changed
  since, rather than reading it as unsigned. An index signed by a key the build does not have reads as unsigned, so an
  installed app that lacks a newer key still reads the project's libraries. oip-web's CI fails on such an index
  instead, so no deploy ships without the key. Get parts says when a library is signed. A dev build also trusts the
  gates' key (`e2e/_library-test-key.mjs`), whose private half is public.

### In the repository and the release pipeline

- **Library sources:** `libraries/<name>/<part>/` holds a first-party library that is not a built-in: the part folder
  (`manifest.json`, `behavior.js`), its `thumbnail.webp` (`npm run thumbnails -- --libraries`) and a
  `description.txt` shown in Get parts. The old-parts corpus records these parts as it records `examples/parts`.
- **Packing:** `npm run build-library` packs a library, append-only (docs/cli.md): `--from libraries/<name>` for a
  library's sources, `--category` or `--part` for built-ins, `--listed` for the parts repository (below). It refuses a
  new first-party version that is not in the old-parts corpus (`test-corpus/parts/`), so every later build runs every
  published version. A library built from a source folder lists what the folder holds: a part whose source is removed
  leaves the index (delisted), while its published files stay and projects that added it keep their copies. The
  packed bytes are the same on every machine: the archive's fixed entry time is built from local fields, because a
  zip stores local time.
- **Signing step:** `npm run sign-library` signs, in a step of its own that runs no part code.
- **Publishing:** [library.yml](../.github/workflows/library.yml), started by hand, reads the published index and packs
  a library's source folder (`from`), a category of built-ins or the listed library (`listed`). It signs the index
  when the `PART_LIBRARY_SIGNING_KEY` secret is set and uploads only the new files to the `oip-parts` bucket, the
  index last. Packing and uploading are separate jobs, so the job that runs parts holds no secret. Part files are
  cached for a year and the index for a minute. The bucket allows GET from any origin
  ([library-bucket-cors.json](../.github/library-bucket-cors.json)), so the site, a self-hosted copy and the desktop
  shell can all read it. The app's fetches need only CORS, so no CORP header is set.
- **The listed library:** the Publish dialog, the sign-in Worker, the submission checks, the parts repository's
  workflows and the listed corpus ([Publishing](#publishing)).
- **Gates:** `e2e/verify-part-library.mjs` packs Containers and Structure and serves them from a second origin with
  the bucket's headers. It adds a part through Get parts, publishes and takes an update with Update and Update all,
  checks the demo's built-ins, and checks that the same index from another host claims none of them unless it is
  signed. It refuses a signed index changed afterwards, shows a listed part's publisher, checks that a library
  without CORS is reported, and adds a library in Settings. `e2e/verify-publish-part.mjs` publishes a part against
  stand-ins for GitHub and the sign-in Worker. `e2e/verify-sim-hang.mjs` runs a part that never returns.

### Libraries

- `oip.structure`: `https://parts.openindustryproject.org/oip.structure/index.json`.
- `oip.containers`: `https://parts.openindustryproject.org/oip.containers/index.json`, listed for everyone
  (`libraries/containers`: the Drum, the IBC tote and the Tote, [cargo-bodies.md](cargo-bodies.md)). The app does not
  ship its parts. A project that holds an app copy of the Tote keeps it, and the copy reads as Containers' version,
  because the fingerprints match.
- `oip.community` ("Community"): the listed library, built from the parts repository and in
  `OFFICIAL_PART_LIBRARIES`.

Known limits: the app has no offline starter set of parts. Rooms recognise first-party code by
`shippedBehaviorHashes`, not by a library's signature.

## Why libraries

A part that ships inside the app waits for an app deploy for every fix, and the app's repository would hold parts for
every kind of line (warehouse, robotics, packaging) whether a user needs them or not. The parts shelf
([parts-shelf.md](parts-shelf.md)) shares parts only inside a team, through a shared folder or a git repository. A
library lets anyone find a part someone else published.

## The rules it keeps

Everything in [part-sources.md](part-sources.md) holds. A library is one more source a project copies from:

- **A project's own copies are the only place its parts come from.** Installing a part from a library copies it in,
  assets included, and stamps `origin.<library>` with the fingerprint it was copied from. Nothing reads a library live.
- **Updates are explicit.** The four statuses and the update dialog are the shelf's and the built-ins'.
- **One layout everywhere a part is stored.** A library version is the same part folder a project's `parts/` holds.
- **No account to use the app.** Building, simulating, installing parts and self-hosting never ask anyone to sign in.
  Only publishing does.

## What a library is

- **A static index.** One JSON file per library listing its parts, each with its versions. A version names its part file
  by a URL that never changes, its content hash, its Part SDK level and its thumbnail. The index names one licence, a
  code licence and an assets licence, that every listed part is published under (`licence` in `PartLibraryIndex`,
  src/core/parts/partLibrary.ts), and an append may not change it. The index is signed with the project's key. There is no
  server and no database.
- **Released on its own schedule.** Publishing a library version adds files and index entries and never rewrites an
  existing one, like `public/part-assets/`. An app deploy and a library release do not wait for each other.
- **Read by version.** The app filters the index by its own `PART_SDK_LEVEL`. A version newer than the app shows
  "needs a newer version of the app" (or "reload" in a tab left open across a deploy) instead of installing.
- **First-party parts can live in libraries.** Projects hold their own copies, so moving a built-in into a library
  changes no project.

## Where it lives

- **Code: oip-web.** The index format and the library source (`src/core`), the Get parts window, the Publish
  dialog, the sign-in Worker (its own folder with its `wrangler` config, as `server/` holds the collab server), the
  corpus step, and the command-line tools the release pipeline runs. A part is checked by the same code the app runs.
- **Parts: their own GitHub repository** (`Open-Industry-Project/parts`), one folder per part under `parts/<id>/`, plus
  the namespace file, the review checklist (REVIEW.md), the pull request template and the licence texts. It is
  separate so a library release never needs an oip-web commit or deploy, and a reviewer can be given access to parts
  without access to the app. Its workflows run oip-web's own scripts, checked out from oip-web's main.
- **Published files: an R2 bucket on its own subdomain** (`parts.openindustryproject.org`), set up like
  `downloads.openindustryproject.org`. Files are copies, never links to an author's repository, because a listed
  version is a permanent test (below) and must not disappear. `/app/` is cross-origin isolated, so the bucket must
  answer with CORS headers or the app's fetches are blocked. An image the app shows straight from the bucket (a
  listed thumbnail) must then be requested with CORS too (`crossorigin`), or the bucket would also need
  `Cross-Origin-Resource-Policy`. Not on the Pages site: that
  would tie each library release to an app deploy. Files never change, so they are served with long cache lifetimes.
- **Self-hosting.** The index URL is a setting. A self-hosted copy mirrors the bucket's files or points at an index of
  its own.

## How a deploy keeps working with published parts

The web app is deployed on every push to `main`, and no web user can stay on an older build. So every build has to
run every part version anyone was ever given. The old-parts corpus (`test-corpus/`, `scripts/part-corpus.mjs`)
enforces that for the project's own parts. A version from another publisher records what it did when it was
listed: `build-library --listed` runs it alone, as the corpus does (`src/sim/partBehaviour.ts`), and writes the digest
into the signed index as the version's `behaviour`. oip-web's CI then runs `scripts/library-corpus.mjs`: it downloads
every listed version from the official libraries (by hash, into `.cache/library-corpus/`, since a file never changes),
checks the signature, and runs `src/sim/libraryCorpus.test.ts`, which fails a build that installs or runs one
differently. That makes each listed version a test the app keeps forever, which is the reason listing is reviewed
(below).

## Two tiers

- **Listed.** In an index, reviewed, in the corpus, protected by every deploy.
- **Unlisted.** Any part file or shelf, shared however people like. It still loads through `upgradeStoredPackage`,
  and the Part SDK level warns when it is newer than the app, but no deploy is bound to it.

Review decides what is listed, never what may exist. Sharing an unlisted part needs nobody's approval or identity.

## Publishing

The part is authored in the app, so publishing starts there: **Publish to Part Library…** (`part.publish`, on one
of the project's own parts that is not `oip.*`; the Scene dock's part menu, the Inspector header and Get parts' Publish
a part), which opens
[PublishPartDialog.tsx](../src/editor/components/PublishPartDialog.tsx).

1. **Checks on the author's machine.** The rules are [core/parts/partSubmission.ts](../src/core/parts/partSubmission.ts), the
   same CI applies: every model and texture inside the part, at most 300,000 triangles, textures at most 4096 pixels a
   side, a part file at most 20 MB, a behavior at most 512 KB. After sign-in, the namespace (below). A problem shows
   in the dialog, where it can be fixed, before anything is sent. Running the part is left to CI, in a capped
   process, so a part that hangs never freezes the author's tab.
2. **The listing.** A description for Get parts and the rights line ticked (`RIGHTS_LINE`, one line, not a DCO
   sign-off). Licences are under [Rules for listed parts](#rules-for-listed-parts).
3. **Sign-in.** GitHub's device flow ([publish/github.ts](../src/editor/publish/github.ts)): GitHub shows a code, the
   author enters it at github.com/login/device, and the app polls for a token with scope `public_repo`, kept in this
   browser only. The two sign-in calls go through the sign-in Worker ([workers/github-signin](../workers/github-signin/)),
   because GitHub answers them without CORS; it holds no secret and keeps nothing. The same flow works in the desktop
   shell.
4. **The pull request.** The app forks the parts repository, commits the part's folder
   ([publish/submission.ts](../src/editor/publish/submission.ts): the part as a `.oippart` holds it, `description.txt`,
   and its card picture) on a branch made from the repository's main, and
   opens the pull request from the fork with the rights line ticked. Nothing is cloned: the Git data API takes blobs,
   a tree, a commit and a branch.
5. **Its state.** The dialog reads the pull request: in review, changes requested with what reviewers and the checks
   said, listed (merged) or closed. A changed part can be sent again as a new version; the same version in review
   cannot.
6. **Checks in CI.** The parts repository's workflows run in two stages. `submission.yml` runs on the pull request with
   no secrets and only names it. `check.yml` runs from main: it reads the author, the changed files and the text from
   GitHub, the namespace file from main and the part folders from the pull request's head as data, checks out oip-web,
   and runs `npm run check-submission` (`scripts/check-submission.mjs`). Each part is built and run in a child process
   of its own, capped at 1.5 GB and 120 s, in the SES sandbox: at its defaults twice (the same result, or it is not
   deterministic), and at each number param's min and max, each boolean flipped and each enum choice. A second job,
   which runs no part code, posts the verdict as a comment and the `parts/check` status.
7. **Listing.** After merging, a maintainer runs [library.yml](../.github/workflows/library.yml) with `listed`
   ticked. Its `build` job reads the parts repository's main (public, no token) and runs `build-library --listed`,
   which records each new version's `behaviour` and its publisher, and drops a part whose folder a takedown removed.
   Its `publish` job signs the index (`sign-library`) and uploads the new files, the index last. The job that runs
   parts holds no secret, and the job that holds them runs no part, so the signing key and the bucket token stay in
   oip-web alone. The `publish` job fetches the published index itself and signs only an append to it whose new files
   match their hashes, so a part that broke out of the build job still cannot get a rewritten entry signed. The parts repository's check reads oip-web through a read-only deploy key
   (`OIP_WEB_DEPLOY_KEY`).

## Publisher identity

- **GitHub is who publishes.** The pull request's author is the publisher, and the listing names them
  (`LibraryPart.publisher`: the account of a `u.<login>.*` id, or the organization that owns the namespace).
- **Namespaces follow GitHub organizations.** `acme.*` belongs to the GitHub organization that has verified the domain
  `acme.com`, and any member may publish under it. A personal account gets `u.<login>.*`. `oip.*` is reserved for
  first-party parts. The namespace file in the parts repository records which organization owns which namespace, and
  CI refuses a pull request whose author is not a public member of it (`namespaceProblem`); the app checks the same
  before sending.
- **One key, the project's.** Every listed file passes the project's CI, so the project signs what it lists, and the
  signature covers the asset hashes, so it vouches for the whole part. Publishers hold no keys. The project's key lives
  in oip-web's CI secrets, never on a laptop:
  whoever holds it can list anything.

## Review

The automated checks run again in CI. A person then checks what a machine cannot:

- **Provenance.** Where the models and textures came from. Nothing derived from a vendor's CAD, software or
  documentation (the vendor boundary in AGENTS.md applies to published parts as it does to the app).
- **Confidentiality.** No customer or real-project names, layouts or data.
- **Fit.** The part serves designing, programming, simulating or validating a line, and it is worth a permanent place
  in the corpus.

The project owner approves every new publisher and every new namespace. After a few clean versions, a publisher's
later versions under their own namespace may be merged on the automated checks alone. The checklist lives in the
parts repository (REVIEW.md), so a second reviewer works from the same text.

## Trust

Part code runs in the SES sandbox ([part-sandbox.md](part-sandbox.md)), which keeps it from reaching the app. SES
has no interrupt or memory cap, so a listed part is held to two more things:

- **Before listing,** CI runs it at each of its settings in a process capped at 1.5 GB and 120 s. A part that hangs,
  recurses for ever or exhausts memory fails there, never in a user's tab.
- **While running,** the simulation worker's watchdog ([part-sandbox.md](part-sandbox.md), "Hangs in the
  simulation") ends a worker that sends no frame for 10 s, names the part it was running and stops the run. The next
  Play starts a fresh worker.

What is left is a part that hangs in the page itself, in `geometry()` at settings no check tried. The room recovery in
part-sandbox.md applies to a room; elsewhere the tab has to be closed.

## Agents

The index is plain JSON, so an agent can search it through the agent door ([agent-tools.md](agent-tools.md)). Text
from a listing (a name, a description, a comment in a behavior) is data written by the publisher. The agent tools hand
it to the agent marked as such, never as instructions.

Listed parts with their recorded behaviour, and example projects with their project tests, are also verified
examples: an agent can be given them as context, and they can serve as an evaluation set.

## Rules for listed parts

1. **One licence for every listed part:** MIT for behavior code, CC BY 4.0 for models and textures. Publishers do not
   choose their own. Both allow any use, training AI models included, and there is no separate training choice. A
   publisher who minds does not publish. Nothing from rooms, shelves or private projects is ever used for training.
2. **Takedowns** go to a published contact address. A part reported credibly as infringing is removed from the index
   and its files deleted within 7 days, the one exception to never deleting a published file. Projects that already
   copied it keep their copies, which the project cannot reach.
3. **Publishing needs a GitHub sign-in.** Nothing else needs an account. A company that does not allow its staff on
   GitHub would not allow them to publish its work either, so there is no other sign-in.
4. **Each submission carries a rights confirmation,** one line, not a DCO.
5. **There are no ratings, payments or store server.**
6. **A privacy policy** ([/privacy/](../privacy/index.html)) covers the GitHub identities the parts repository
   holds.

## App code names capabilities, not parts

A built-in is a part the app happens to ship. When app code names a part by id, that part can never move to a
library, and a part from a library can never do what it does. So the engine offers capabilities that a part declares
(a cargo body, a snap connector, a hidden-from-catalog flag), and app code names a part only where it is content: a
demo scene, the tutorial, the list of parts the app ships. `src/core/parts/partIdCoupling.test.ts` holds that line. It
lists the content files and the remaining couplings, each with what removes it, and fails on a new one or on a listed
file that names no part, so the list can only shrink.

Which parts stay in the app and which can be library-only follows from it:

- **In the app:** parts the engine still names, parts the demo, tutorial or a worked example uses, and core equipment.
- **Library-only:** standalone parts nothing in the app names that serve a narrower set of users. A new part of that
  kind is published to a library from the start rather than shipped in the app.

A worked example that uses a part moved out of the app holds its own copy of it.

A part can leave the app only where every project that places it carries its own copy. A project saved in format 5 or
later always does (every part it uses is its own copy in the project's parts), and so does a room. A format 4 or older
project holds no copy of a built-in it places, so it refuses to load once the app no longer ships one of them:
"parts[n].packageId ... is neither in the project's part library nor a built-in part of this app". So a built-in may
move to a library only when every app build that shipped it wrote format 5 or later. A built-in that shipped before
format 5 needs a fallback first, such as copying the missing part in from its first-party library when the project
opens.
